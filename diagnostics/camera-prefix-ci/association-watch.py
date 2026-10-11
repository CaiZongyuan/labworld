import json,time,datetime,os
from pathlib import Path
base=Path(os.environ['CAMERA_DIAGNOSTIC_EVIDENCE'])
work=Path.cwd()
assocpath=base/'association.json'
initial=json.loads(assocpath.read_text())
expected=['--config','.scratch/camera-prefix-ci/playwright.config.ts','.scratch/camera-prefix-ci/camera-prefix.spec.ts']
existing=set(initial['existingSuiteNames'])
suitepath=None
previous=None
until=time.monotonic()+360
while time.monotonic()<until:
 try:
  if suitepath is None:
   for p in (work/'.scratch/vnext-m1').glob('browser-suite-*/owned-resources.json'):
    if p.parent.name in existing:continue
    d=json.loads(p.read_text())
    if d.get('profiles')==[expected]:suitepath=p;break
  if suitepath is not None:
   suite=json.loads(suitepath.read_text())
   group={(c.get('pid'),c.get('token')) for c in suite.get('consumers',[])}
   services=[]
   for p in (work/'.scratch/vnext-m1').glob('lab-word-m1-*/owned-resources.json'):
    d=json.loads(p.read_text());creator=d.get('creator',{})
    if (creator.get('pid'),creator.get('start')) in group:
     services.append({'ledger':str(p),'runId':d['runId'],'state':d['state'],'creator':creator,'port':d.get('port'),'directory':d.get('directory'),'processes':d.get('processes',[]),'inProcessConsumers':d.get('inProcessConsumers',[]),'launchIntent':d.get('launchIntent')})
   browserpath=None;browser=None
   for service in services:
    candidate=Path(service['ledger']).with_name('browser-owned-resources.json')
    if candidate.exists():
     d=json.loads(candidate.read_text());supervisor=d.get('supervisor',{})
     if (supervisor.get('pid'),supervisor.get('token')) in group:browserpath=candidate;browser=d;break
   detail={'state':suite['state'],'suiteLedger':str(suitepath),'suiteRunId':suite['runId'],'supervisor':suite['supervisor'],'suiteConsumers':suite.get('consumers',[]),'services':services,'serviceLedgers':[s['ledger'] for s in services],'browserLedger':str(browserpath) if browserpath else None,'browserRunId':browser.get('runId') if browser else None,'browserSupervisor':browser.get('supervisor') if browser else None,'browserConsumers':browser.get('consumers',[]) if browser else [],'ownedLedgers':[str(suitepath)]+([str(browserpath)] if browserpath else [])+[s['ledger'] for s in services]}
   signature=json.dumps(detail,sort_keys=True)
   if signature!=previous:
    assoc=json.loads(assocpath.read_text())
    immutable=assoc.setdefault('immutableFirstSeenServices',{})
    for service in services:
     first=immutable.setdefault(service['runId'],{'ledger':service['ledger'],'runId':service['runId'],'creator':service['creator'],'firstSeenAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'originalDirectory':service['directory'],'port':service['port'],'processProofs':[],'inProcessConsumerProofs':[]})
     for proof in service['processes']:
      if proof not in first['processProofs']:first['processProofs'].append(proof)
     for proof in service['inProcessConsumers']:
      if proof not in first['inProcessConsumerProofs']:first['inProcessConsumerProofs'].append(proof)
    assoc.update(detail);assoc['lastOwnershipReceiptAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();temporary=assocpath.with_suffix('.tmp');temporary.write_text(json.dumps(assoc,indent=2)+'\n');temporary.replace(assocpath);previous=signature
   if suite['state'] in ['failed','completed'] and (suitepath.parent/'results.json').exists():
    print(json.dumps({'suiteLedger':str(suitepath),'state':suite['state'],'serviceLedgers':len(services),'browserLedger':str(browserpath) if browserpath else None}));break
 except (FileNotFoundError,json.JSONDecodeError):pass
 time.sleep(.1)
else:
 print('Association watcher timed out; runtime ledger remains authoritative')
