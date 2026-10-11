"""Owned Newton source: prelease physics preparation, then one admitted experiment."""
import argparse
import asyncio
from contextlib import AsyncExitStack, redirect_stdout
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import select
import signal
import subprocess
import sys
import time
import threading
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).parent
sys.path.insert(0,str(ROOT.parent/'synthetic-motion'))
from motion_codec import CODEC, MAX_CONTROL_BYTES, MotionProtocolError, control_json, encode_snapshot, parse_session_control, parse_u64, parse_welcome
from publisher import SessionOutbox, arm_parent_guard, run_owned, transport_url
from recording_source import admit_recording
from recording_codec import sha256
from synthetic import parse_startup


def source_header(run, physics):
    files = sorted([ROOT/name for name in ('coordinates.py','facts_owner.py','physics.py','publisher.py','scene_loader.py')] +
                   [ROOT.parent/'synthetic-motion'/name for name in ('motion_codec.py','publisher.py','recording_codec.py','recording_source.py','synthetic.py')])
    chunks = []
    for path in files:
        data = path.read_bytes()
        chunks.extend((str(path.relative_to(ROOT.parent)).encode()+b'\0',len(data).to_bytes(4,'little'),data))
    gpu = subprocess.run(['nvidia-smi','--query-gpu=name,driver_version','--format=csv,noheader'],capture_output=True,text=True,timeout=3,check=True).stdout.splitlines()[0]
    name,driver = [value.strip() for value in gpu.rsplit(',',1)]
    dependencies = []
    for name_ in ('isaaclab','mujoco','mujoco-warp','newton','numpy','scipy','trimesh','warp-lang','websockets'):
        try:
            version = importlib.metadata.version(name_)
        except importlib.metadata.PackageNotFoundError:
            version = None
        dependencies.append({'name':name_,'version':version,'sha256':None})
    return {'source_kind':'newton','implementation':{'name':'lab-word-newton-so101','version':'1','sha256':sha256(b''.join(chunks))},
            'python_version':'.'.join(map(str,sys.version_info[:3])), 'dependencies':dependencies,
            'capture_policy':{'selection':'all-selected','sample_hz':30,'motion_codec':CODEC,'first_source_sequence':'1','first_source_event_sequence':'1'},
            'runtime':{'device':str(run.device),'gpu':run.device.name,'driver':driver,'solver':'Newton SolverMuJoCo/MJWarp',
                       'profile_sha256':physics['profile_sha256'],'physics_step_hz':240,'control_hz':30,'live_rate_hz':physics['live_rate_hz']}}


async def publish(run, value):
    from websockets.asyncio.client import connect
    from physics import PhysicsOwner
    physics = value['physics']
    startup = parse_startup(json.dumps(value))
    if startup.recording is None:
        raise ValueError('Newton requires reliable Recording admission')
    if list(startup.body_order)!=run.profile['body_order'] or list(startup.joint_order)!=run.profile['joint_order']:
        raise ValueError('Newton dictionary mismatch')
    if value['initial_poses']!=run.profile['initial_poses'] or value['initial_joints']!=run.profile['initial_joints']:
        raise ValueError('Admitted Newton initial state changed')
    url = transport_url(startup.url)
    parsed = urlsplit(url)
    recording_url = transport_url(urlunsplit((parsed.scheme,parsed.netloc,startup.recording['websocket_path'],'','')))
    outbox = SessionOutbox()
    tasks = []
    owner = None
    last_revision = -1
    initial = asyncio.get_running_loop().create_future()
    async with AsyncExitStack() as sockets:
        evidence=None
        evidence_count=0
        if os.environ.get('LAB_WORD_NEWTON_EVIDENCE_DIRECTORY'):
            evidence=sockets.enter_context((Path(os.environ['LAB_WORD_NEWTON_EVIDENCE_DIRECTORY'])/(startup.session_id+'.jsonl')).open('x',encoding='utf-8',buffering=1))
        live = await sockets.enter_async_context(connect(url,open_timeout=3,close_timeout=3,ping_interval=1,ping_timeout=3,
                                                        max_size=MAX_CONTROL_BYTES,max_queue=1,write_limit=65536,compression=None,proxy=None))
        await live.send(json.dumps({'type':'motion.hello','version':1,'role':'publisher','session_id':startup.session_id,
                                    'scene_hash':startup.scene_hash,'codec':CODEC,'ticket':startup.ticket,'preferred_rate_hz':30},separators=(',',':')))
        welcome = parse_welcome(await asyncio.wait_for(live.recv(),3))
        if welcome['session_id']!=startup.session_id or welcome['scene_hash']!=startup.scene_hash or welcome['pose_keys']!=list(startup.body_order) or welcome['joint_keys']!=list(startup.joint_order):
            raise ValueError('Newton admission mismatch')
        epoch = parse_u64(welcome['epoch'])
        reliable = await sockets.enter_async_context(connect(recording_url,open_timeout=3,close_timeout=3,ping_interval=1,ping_timeout=3,
                                                            max_size=16384,max_queue=1,write_limit=65536,compression=None,proxy=None))
        recording = await admit_recording(reliable,startup.recording,welcome,source_header(run,physics))
        def encode(sample,sequence):
            nonlocal evidence_count
            started=time.monotonic()
            frame=encode_snapshot({'epoch':epoch,'sequence':sequence,'mapping_revision':welcome['mapping_revision'],**sample})
            run.metrics['encode_ms'].append((time.monotonic()-started)*1000)
            run.metrics['encode_ms']=run.metrics['encode_ms'][-900:]
            if evidence is not None and evidence_count<900:
                native=dict(run.last_native)
                physical=run.physical_sample()
                evidence.write(json.dumps({'sequence':sequence,'sim_time_ns':sample['sim_time_ns'],'frame_sha256':sha256(frame),'native':native,'physical':physical},separators=(',',':'))+'\n')
                evidence_count+=1
            return frame
        owner = PhysicsOwner(run,encode,recording.limits)
        async def pump():
            while True:
                owner.ack(recording.durable_sequence)
                fact = owner.take()
                if fact is None:
                    await asyncio.sleep(.001)
                    continue
                sequence,_,frame = fact
                recording.capture(frame,sequence,not owner.running)
                if sequence==1:
                    initial.set_result(frame)
                elif owner.running and (physics['live_rate_hz']==30 or sequence%2==0):
                    outbox.offer(frame)
        async def write():
            while True:
                frame,ack,done = await outbox.take_message()
                try:
                    await live.send(frame)
                    outbox.sent += 1
                    if ack is not None:
                        await live.send(ack)
                        done.set_result(None)
                except BaseException as error:
                    if done is not None and not done.done():
                        done.set_exception(error)
                    raise
        async def control():
            nonlocal last_revision
            async for message in live:
                received = time.monotonic()
                data = control_json(message)
                if data.get('type')=='motion.status':
                    if data.get('state') not in ('waiting','live','stale','paused'):
                        raise ValueError('Session ended')
                    continue
                request = parse_session_control(message)
                if request['session_id']!=startup.session_id or request['epoch']!=welcome['epoch'] or request['revision']<=last_revision:
                    raise ValueError('Lifecycle scope rejected')
                action = request['action']
                if (action=='pause' and not owner.running) or (action=='resume' and owner.running):
                    raise ValueError('Lifecycle state conflict')
                deadline = received+recording.deadline_seconds
                sequence,sim_time,boundary = await asyncio.to_thread(owner.boundary)
                while recording.selected_sequence < sequence:
                    if time.monotonic()>=deadline:
                        raise TimeoutError('Selected boundary handoff timed out')
                    await asyncio.sleep(.001)
                recording.lifecycle(request,sequence,sim_time)
                if action=='stop':
                    recording.end(request,sim_time)
                await recording.drain(deadline,ended=action=='stop')
                ack = {'type':'motion.session_ack',**{key:request[key] for key in ('session_id','epoch','transition_id','revision','action')},
                       'result':'applied','last_sequence':str(sequence),'sim_time_ns':str(sim_time)}
                # Correlated boundaries bypass live decimation and latest replacement.
                await outbox.offer_boundary(boundary,json.dumps(ack,separators=(',',':')))
                last_revision = request['revision']
                if action=='stop':
                    return
                if action=='resume':
                    owner.resume()
            raise ValueError('Gateway disconnected')
        try:
            tasks = [asyncio.create_task(recording.write()),asyncio.create_task(recording.read()),
                     asyncio.create_task(recording.watchdog()),asyncio.create_task(pump())]
            initial_frame = await asyncio.wait_for(initial,recording.deadline_seconds)
            await recording.drain(time.monotonic()+recording.deadline_seconds)
            await live.send(initial_frame)
            outbox.sent += 1
            owner.resume()
            tasks.extend([asyncio.create_task(write()),asyncio.create_task(control())])
            done,_ = await asyncio.wait(tasks,return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        finally:
            try:
                owner.close()
            finally:
                live.transport.abort(); reliable.transport.abort()
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks,return_exceptions=True)
                if outbox.boundary is not None:
                    outbox.boundary[2].cancel()
                recording.clear()
    return {'selected':owner.sequence,'live_sent':outbox.sent,'live_overwritten':outbox.overwritten,
            'physics_steps':run.step_count,'metrics':run.metrics,**recording.report()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepare-stdin',action='store_true')
    parser.add_argument('--startup-stdin',action='store_true')
    args = parser.parse_args()
    if not (args.prepare_stdin or args.startup_stdin):
        parser.error('Use the owned prelease or admitted stdin entrypoint')
    arm_parent_guard()
    extracted = None
    loading = threading.Event()
    loading.set()
    guard = None
    try:
        value = control_json(sys.stdin.readline(MAX_CONTROL_BYTES+1))
        def watch_prelease_stdin():
            while loading.is_set():
                ready,_,_ = select.select([sys.stdin.fileno()],[],[],.1)
                if ready and loading.is_set():
                    # During preparation there is no legal second message yet; EOF stops immediately.
                    os.read(sys.stdin.fileno(),1)
                    os.kill(os.getpid(),signal.SIGTERM)
                    return
        guard = threading.Thread(target=watch_prelease_stdin,name='newton-prelease-stdin-owner',daemon=True)
        guard.start()
        physics = value['physics']
        from scene_loader import extract_scene, supported_profile
        supported = supported_profile()
        if physics['profile_sha256']!=supported['hash'] or physics['profile']['hash']!=supported['hash']:
            raise ValueError('Unsupported source profile')
        directory = Path(os.environ['LAB_WORD_NEWTON_SCENE_DIRECTORY'])
        temp = Path(os.environ['TMPDIR'])
        extracted = extract_scene(directory/'base.glb',temp,supported)
        # Invalid archive/profile fails before importing Newton or initializing CUDA.
        with redirect_stdout(sys.stderr):
            from physics import NewtonRun
            run = NewtonRun(physics['profile'],extracted)
        loading.clear()
        guard.join(timeout=1)
        if args.prepare_stdin:
            print(json.dumps({'type':'newton.prepared','profile_sha256':supported['hash'],'initial':run.sample()}),flush=True)
            value = control_json(sys.stdin.readline(MAX_CONTROL_BYTES+1))
            if value['physics']!=physics:
                raise ValueError('Prepared source snapshot changed before admission')
        with redirect_stdout(sys.stderr):
            result = asyncio.run(run_owned(publish(run,value),watch_stdin=True))
        print(json.dumps(result,separators=(',',':')),flush=True)
        return 0
    except (KeyboardInterrupt,asyncio.CancelledError):
        return 130
    except Exception as error:
        print('Newton source stopped: '+type(error).__name__,file=sys.stderr)
        return 1
    finally:
        loading.clear()
        if guard is not None:
            guard.join(timeout=1)
        if extracted is not None:
            shutil.rmtree(extracted)


if __name__=='__main__':
    sys.exit(main())
