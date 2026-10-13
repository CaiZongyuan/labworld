"""Bounded source-owned execution of the original task and existing checkpoint."""
import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import signal
import sys
import traceback


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--project', type=Path, required=True)
    parser.add_argument('--checkpoint', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--steps', type=int, default=3)
    parser.add_argument('--reset-after', type=int)
    parser.add_argument('--metadata', type=Path)
    parser.add_argument('--task', default='IsaacTutorial-Place-Vial-SO101')
    from isaaclab.app import add_launcher_args, launch_simulation
    add_launcher_args(parser)
    args = parser.parse_args()
    sys.path.insert(0, str(args.project / 'src'))
    import torch
    import warp as wp
    wp.config.kernel_cache_dir = os.environ['WARP_CACHE_PATH']
    import isaaclab_tutorial.tasks
    from isaaclab.envs import ManagerBasedRLEnv
    from isaaclab_tasks.utils import load_cfg_from_registry
    from isaaclab_rl.rsl_rl import RslRlVecEnvWrapper, handle_deprecated_rsl_rl_cfg
    from rsl_rl.runners import OnPolicyRunner
    import source_adapter
    cfg = load_cfg_from_registry(args.task, 'env_cfg_entry_point')
    cfg.play_mode()
    cfg.scene.num_envs = 1
    cfg.sim.device = args.device
    cfg.seed = 42
    cfg.log_dir = str(args.output / 'task-log')
    cfg.recorders = source_adapter.recorders(args.output, args.metadata)
    agent_cfg = handle_deprecated_rsl_rl_cfg(load_cfg_from_registry(args.task, 'rsl_rl_cfg_entry_point'),
                                           importlib.metadata.version('rsl-rl-lib'))
    agent_cfg.device = args.device
    with launch_simulation(cfg, args) as physics_cfg:
        cfg.sim.physics = physics_cfg
        env = ManagerBasedRLEnv(cfg)
        try:
            wrapper = RslRlVecEnvWrapper(env, clip_actions=agent_cfg.clip_actions)
            runner = OnPolicyRunner(wrapper, agent_cfg.to_dict(), log_dir=None, device=args.device)
            runner.load(str(args.checkpoint), map_location=args.device)
            policy = runner.get_inference_policy(device=args.device)
            observations = wrapper.get_observations()
            with torch.inference_mode():
                for i in range(args.steps):
                    observations, _, done, _ = wrapper.step(policy(observations))
                    policy.reset(done)
                    if args.reset_after == i+1:
                        observations, _ = wrapper.reset()
                        policy.reset(torch.ones(env.num_envs, device=env.device, dtype=torch.bool))
            (args.output / 'native-result.json').write_text(json.dumps({'status': 'complete', 'steps': args.steps,
                'task': args.task, 'checkpoint_loaded': True, 'reset_after': args.reset_after,
                'versions': {name: importlib.metadata.version(name) for name in
                             ('isaaclab', 'newton', 'warp-lang', 'mujoco', 'mujoco-warp', 'torch', 'rsl-rl-lib')}} ,indent=2)+'\n')
        finally:
            env.close()


def interrupt(_signal, _frame):
    raise KeyboardInterrupt


if __name__ == '__main__':
    signal.signal(signal.SIGINT, interrupt)
    signal.signal(signal.SIGTERM, interrupt)
    try:
        main()
    except BaseException:
        traceback.print_exc()
        raise SystemExit(1)
