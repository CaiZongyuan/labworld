import datetime
import os
import json
import re
import shutil
import socket
import sys
from pathlib import Path

worktree=Path.cwd()
evidence=Path(os.environ['CAMERA_DIAGNOSTIC_EVIDENCE'])
stage = sys.argv[1]
association_path = evidence/'association.json'
association = json.loads(association_path.read_text()) if association_path.exists() else {}
paths = [Path(p) for p in association.get('ownedLedgers', [])]
launcher = evidence/'launcher-owned-resources.json'
if launcher.exists(): paths.append(launcher)
processes = {}
for entry in Path('/proc').iterdir():
    if not entry.name.isdigit():
        continue
    try:
        stat = (entry/'stat').read_text().split(') ', 1)[1].split()
        if stat[0] == 'Z':
            continue
        processes[int(entry.name)] = {
            'pid':int(entry.name), 'state':stat[0], 'ppid':int(stat[1]),
            'group':int(stat[2]), 'session':int(stat[3]), 'token':stat[19],
            'name':(entry/'comm').read_text().strip(),
            'executable':str((entry/'exe').readlink()), 'cwd':str((entry/'cwd').readlink()),
        }
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        pass

def identity(proof):
    actual=processes.get(proof.get('pid')) if proof else None
    expected=proof.get('token', proof.get('start')) if proof else None
    return {'pid':proof.get('pid') if proof else None, 'expectedToken':expected,
            'actualToken':actual.get('token') if actual else None,
            'identityAlive':bool(actual and expected and actual['token']==expected)}

records=[]
ports=[]
owned_exact=set()
for path in paths:
    data=json.loads(path.read_text())
    supervisor=data.get('supervisor',data.get('creator',{}))
    consumers=[]
    for consumer in data.get('consumers',[]):
        actual=[p for p in processes.values() if p['group']==consumer.get('pid') and p['session']==consumer.get('pid')]
        consumers.append({'pid':consumer.get('pid'),'exactIdentity':identity(consumer),'actualGroupMembers':actual})
        owned_exact.update((p['pid'],p['token']) for p in actual if any(p['pid']==m.get('pid') and p['token']==m.get('token') for m in consumer.get('members',[])))
    service_processes=[identity(p) for p in data.get('processes',[])]
    owned_exact.update((p['pid'],p['actualToken']) for p in service_processes if p['identityAlive'])
    records.append({'ledger':str(path),'runId':data['runId'],'state':data['state'],
                    'supervisor':identity(supervisor),'consumers':consumers,
                    'serviceProcesses':service_processes,'directory':data.get('directory'),
                    'launchIntent':data.get('launchIntent'),'inProcessConsumers':data.get('inProcessConsumers',[]),
                    'containers':data.get('containers',data.get('docker',[])), 'port':data.get('port')})
    if data.get('port'):
        client=socket.socket()
        client.settimeout(0.5)
        try:
            result=client.connect_ex(('127.0.0.1',data['port']))
        finally:
            client.close()
        ports.append({'port':data['port'],'connectResult':result,'connectionRefused':result==111,'ledger':str(path)})

scoped=[p for p in processes.values() if re.search(r'node|chrome|chromium|playwright|vite|esbuild|codex|orca|electron',p['name']+' '+p['executable'],re.I)]
task_runtime=[p for p in scoped if (p['pid'],p['token']) in owned_exact]
unowned=[p for p in scoped if (p['pid'],p['token']) not in owned_exact]
usage=shutil.disk_usage(worktree)
docker=shutil.which('docker')
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'stage':stage,
        'recordedOwnedIdentities':records,'ownedServicePorts':ports,'taskRuntimeProcesses':task_runtime,
        'externalOrUnknownNodeBrowserToolProcesses':unowned,'externalOrUnknownCount':len(unowned),
        'docker':{'available':bool(docker),'executable':docker,'containers':'UNKNOWN global; no Docker used by this run','volumes':'UNKNOWN global; no Docker used','networks':'UNKNOWN global; no Docker used','diskUsage':'UNKNOWN global Docker; this occurrence uses no Docker'},
        'disk':{'totalBytes':usage.total,'usedBytes':usage.used,'freeBytes':usage.free},
        'signals':0,'deletions':0,'inventoryScope':'Node/browser/build/agent tools globally; explicit association-owned ledgers; no raw cmdline or environment retained',
        'retained':{'evidence':'one diagnostic occurrence artifact','browserCache':'hosted runner installation','nodeToolchain':'hosted runner pinned prerequisite','pnpmStore':'hosted runner dependency installation','externalTools':'external/unknown owners; preserved'}}
destination=evidence/(stage+'-inventory.json')
destination.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'path':str(destination),'recordedLedgers':len(records),'ownedRuntimeCount':len(task_runtime),'externalUnknownCount':len(unowned),'allRecordedGroupsEmpty':all(not c['actualGroupMembers'] for r in records for c in r['consumers']),'allRecordedSupervisorsStopped':all(not r['supervisor']['identityAlive'] for r in records),'allRecordedServicePortsRefuse':all(p['connectionRefused'] for p in ports),'dockerAvailable':bool(docker),'signals':0,'deletions':0}))
