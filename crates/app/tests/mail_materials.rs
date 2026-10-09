use labos_threejs_app::modules::mail::{Binding, MailService, MaterialError};
use labos_threejs_platform::mail::{SmtpSettings, TlsMode};
fn service(key: &[u8], version: i32) -> MailService {
    MailService::new(
        SmtpSettings {
            host: "127.0.0.1".into(),
            port: 1025,
            tls: TlsMode::Local,
            from: "noreply@example.test".into(),
            username: None,
            password: None,
            timeout: std::time::Duration::from_secs(3),
        },
        key,
        version,
    )
    .unwrap()
}
#[test]
fn encrypted_material_uses_distinct_nonces_and_authenticates_binding_ciphertext_and_key_version() {
    let mail = service(&[0x11; 32], 1);
    let binding = Binding {
        purpose: "identity.password_reset",
        resource_id: "reset-one",
        job_id: "job-one",
        user_id: "user-one",
        expires_at: 1800,
    };
    let text = b"capture-only-material";
    let mut sealed = mail.seal(&binding, text).unwrap();
    let other = mail.seal(&binding, text).unwrap();
    assert!(sealed.nonce != other.nonce);
    assert!(
        !sealed
            .ciphertext
            .windows(text.len())
            .any(|bytes| bytes == text)
    );
    assert!(mail.open(&binding, &sealed).unwrap() == text);
    let wrong = Binding {
        resource_id: "another-reset",
        ..binding
    };
    assert!(matches!(
        mail.open(&wrong, &sealed),
        Err(MaterialError::Invalid)
    ));
    assert!(matches!(
        service(&[0x22; 32], 1).open(&binding, &sealed),
        Err(MaterialError::Invalid)
    ));
    assert!(matches!(
        service(&[0x11; 32], 2).open(&binding, &sealed),
        Err(MaterialError::KeyUnavailable)
    ));
    sealed.key_version = 2;
    assert!(matches!(
        service(&[0x11; 32], 2).open(&binding, &sealed),
        Err(MaterialError::Invalid)
    ));
    sealed.key_version = 1;
    sealed.ciphertext[0] ^= 1;
    assert!(matches!(
        mail.open(&binding, &sealed),
        Err(MaterialError::Invalid)
    ));
}
#[test]
fn plaintext_capture_is_local_only_and_both_verified_tls_builders_are_constructible() {
    for tls in [TlsMode::Wrapper, TlsMode::StartTls] {
        assert!(
            labos_threejs_platform::mail::SmtpSender::new(SmtpSettings {
                host: "smtp.example.test".into(),
                port: 587,
                tls,
                from: "noreply@example.test".into(),
                username: None,
                password: None,
                timeout: std::time::Duration::from_secs(3)
            })
            .is_ok()
        );
    }
    assert!(
        labos_threejs_platform::mail::SmtpSender::new(SmtpSettings {
            host: "smtp.example.test".into(),
            port: 1025,
            tls: TlsMode::Local,
            from: "noreply@example.test".into(),
            username: None,
            password: None,
            timeout: std::time::Duration::from_secs(3)
        })
        .is_err()
    );
}
