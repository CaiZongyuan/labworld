"""Explicit standalone GPU readiness/physics measurement. It is not browser/Recording acceptance."""
import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import sys
import time


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-glb',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--cache',type=Path,required=True)
    parser.add_argument('--steps',type=int,default=120)
    args=parser.parse_args()
    if args.steps<8 or args.steps>4320 or args.steps%8:
        parser.error('Use 8–4320 fixed physics steps in batches of eight.')
    cache=args.cache.resolve();cache.mkdir(parents=True,exist_ok=True)
    for key,name in {'WARP_CACHE_PATH':'warp','CUDA_CACHE_PATH':'cuda','XDG_CACHE_HOME':'xdg','TMPDIR':'tmp','TORCH_HOME':'torch','NUMBA_CACHE_DIR':'numba'}.items():
        path=cache/name;path.mkdir(exist_ok=True);os.environ[key]=str(path)
    from scene_loader import extract_scene,supported_profile
    profile=supported_profile()
    scene=extract_scene(args.base_glb,cache/'tmp',profile)
    progress=args.output.with_suffix('.progress.json')
    progress.write_text(json.dumps({'phase':'constructing','completed_steps':0,'selected_batches':0}))
    run=None
    try:
        from physics import NewtonRun
        run=NewtonRun(profile,scene)
        samples=[run.physical_sample()]
        start=time.monotonic()
        for _ in range(args.steps//8):
            run.step();run.sample()
            samples.append(run.physical_sample())
            progress.write_text(json.dumps({'phase':'stepping','completed_steps':run.step_count,'selected_batches':run.step_count//8}))
        engine_seconds=float(run.solver.mjw_data.time.numpy()[0])
        if abs(engine_seconds-run.step_count/240)>.01:
            raise ValueError('Actual GPU solver clock disagrees with completed fixed steps')
        report={'scope':'standalone source readiness/physics; no HTTP, Recording or browser pass',
                'profile_sha256':profile['hash'],'device':str(run.device),'gpu':run.device.name,
                'python':sys.version.split()[0],'versions':{name:importlib.metadata.version(name) for name in ('newton','warp-lang','mujoco','mujoco-warp')},
                'steps':run.step_count,'selected_readbacks':args.steps//8,'simulation_seconds':run.step_count/240,
                'actual_engine_seconds':engine_seconds,
                'step_window_seconds':time.monotonic()-start,'metrics':run.metrics,'physical_samples':samples}
        args.output.write_text(json.dumps(report,indent=2))
        print(json.dumps({'output':str(args.output),'steps':run.step_count,'scope':report['scope']}))
    finally:
        if run is not None:run.close()
        shutil.rmtree(scene)


if __name__=='__main__':
    main()
