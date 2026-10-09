use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::Notify,
    task::{JoinHandle, JoinSet},
};

/// A test-owned TCP forwarding boundary; all replies still come from the real Redis.
pub struct RedisGate {
    pub url: String,
    entered: Arc<Notify>,
    release: Arc<Notify>,
    task: JoinHandle<()>,
}
impl RedisGate {
    pub async fn new(target: &'static [u8]) -> Self {
        let destination = url::Url::parse(&std::env::var("REDIS_URL").unwrap()).unwrap();
        let destination = format!(
            "{}:{}",
            destination.host_str().unwrap(),
            destination.port().unwrap_or(6379)
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("redis://{}/", listener.local_addr().unwrap());
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let gate_entered = entered.clone();
        let gate_release = release.clone();
        let first_get = Arc::new(AtomicBool::new(true));
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    accepted=listener.accept()=>{
                        let Ok((front,_))=accepted else {break;};
                        let destination=destination.clone();let entered=gate_entered.clone();let release=gate_release.clone();let first_get=first_get.clone();
                        connections.spawn(async move {
                            let Ok(back)=TcpStream::connect(destination).await else {return;};
                            let (front_read,mut front_write)=front.into_split();let (mut back_read,mut back_write)=back.into_split();
                            let forward=async {
                                let mut reader=BufReader::new(front_read);
                                while let Ok(Some((name,command)))=command(&mut reader).await {
                                    if name.eq_ignore_ascii_case(target)&&first_get.swap(false,Ordering::SeqCst) {
                                        entered.notify_one();release.notified().await;
                                    }
                                    back_write.write_all(&command).await?;
                                }
                                Ok::<_,std::io::Error>(())
                            };
                            tokio::select! {_=forward=>{},_=tokio::io::copy(&mut back_read,&mut front_write)=>{}}
                        });
                    },
                    Some(_)=connections.join_next(),if !connections.is_empty()=>{},
                }
            }
        });
        Self {
            url,
            entered,
            release,
            task,
        }
    }
    pub async fn wait_for_command(&self) {
        tokio::time::timeout(std::time::Duration::from_secs(3), self.entered.notified())
            .await
            .expect("command reached the controlled Redis boundary");
    }
    pub async fn stop(&mut self) {
        self.task.abort();
        let _ = (&mut self.task).await;
    }
    pub fn release(&self) {
        self.release.notify_one();
    }
}
impl Drop for RedisGate {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn command(
    reader: &mut BufReader<tokio::net::tcp::OwnedReadHalf>,
) -> std::io::Result<Option<(Vec<u8>, Vec<u8>)>> {
    let mut line = String::new();
    if reader.read_line(&mut line).await? == 0 {
        return Ok(None);
    }
    let invalid = || {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "invalid test Redis command",
        )
    };
    let count: usize = line
        .strip_prefix('*')
        .and_then(|v| v.strip_suffix("\r\n"))
        .and_then(|v| v.parse().ok())
        .filter(|v| *v > 0 && *v <= 32)
        .ok_or_else(invalid)?;
    let mut bytes = line.as_bytes().to_vec();
    let mut name = Vec::new();
    for i in 0..count {
        line.clear();
        reader.read_line(&mut line).await?;
        let len: usize = line
            .strip_prefix('$')
            .and_then(|v| v.strip_suffix("\r\n"))
            .and_then(|v| v.parse().ok())
            .filter(|v| *v <= 2 * 1024 * 1024)
            .ok_or_else(invalid)?;
        bytes.extend_from_slice(line.as_bytes());
        let mut argument = vec![0; len + 2];
        reader.read_exact(&mut argument).await?;
        if !argument.ends_with(b"\r\n") {
            return Err(invalid());
        }
        if i == 0 {
            name = argument[..len].to_vec();
        }
        bytes.extend_from_slice(&argument);
    }
    Ok(Some((name, bytes)))
}
