"""Read-only Newton source tools. Run --help for the public commands."""
import argparse
import json
from pathlib import Path
import sys

from format import SourceToolError, validate_manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    validate = commands.add_parser('validate', help='Validate a source scene manifest and its resources.')
    validate.add_argument('--manifest', type=Path, required=True)
    export = commands.add_parser('export', help='Export a source USD baseline and current snapshot.')
    export.add_argument('--scene', type=Path, required=True)
    export.add_argument('--source-id', required=True)
    export.add_argument('--output', type=Path, required=True)
    export.add_argument('--blender', required=True)
    export.add_argument('--snapshot', type=Path)
    export.add_argument('--metadata', type=Path)
    capture = commands.add_parser('capture', help='Run a bounded original-source policy and record real native hooks.')
    capture.add_argument('--project', type=Path, required=True)
    capture.add_argument('--checkpoint', type=Path, required=True)
    capture.add_argument('--output', type=Path, required=True)
    capture.add_argument('--device', default='cuda:0')
    capture.add_argument('--steps', type=int, default=3)
    capture.add_argument('--reset-after', type=int)
    capture.add_argument('--metadata', type=Path)
    capture.add_argument('--cache-directory', type=Path)
    cleanup = commands.add_parser('cleanup', help='Reconcile only an explicitly owned interrupted output run.')
    cleanup.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'cleanup':
        from ownership import recover
        print(json.dumps(recover(args.output)))
        return 0
    if args.command == 'capture':
        import hashlib
        import os
        from ownership import OwnedRun
        if not 1 <= args.steps <= 600:
            raise SourceToolError('step_count_invalid', str(args.steps))
        protected = [args.checkpoint.resolve(), *args.project.resolve().joinpath('src').rglob('*.py'),
                     *args.project.resolve().joinpath('src').rglob('*.pt')]
        fingerprints = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in protected}
        with OwnedRun(args.output, 'capture') as owner:
            env = os.environ.copy()
            cache = args.cache_directory.resolve() if args.cache_directory else owner.directory / 'cache'
            cache.mkdir(parents=True, exist_ok=True)
            owner.ledger['cache'] = {'directory': str(cache), 'owned': args.cache_directory is None,
                                     'consumer': owner.run_id, 'purpose': 'Native source loading/JIT'}
            for key, folder in {'TMPDIR':'tmp','WARP_CACHE_PATH':'warp','CUDA_CACHE_PATH':'cuda','XDG_CACHE_HOME':'xdg',
                                'TORCH_HOME':'torch','NUMBA_CACHE_DIR':'numba','MPLCONFIGDIR':'matplotlib',
                                'HF_HOME':'huggingface','TORCHINDUCTOR_CACHE_DIR':'torchinductor',
                                'PYTORCH_KERNEL_CACHE_PATH':'torch-kernels'}.items():
                path = cache / folder
                path.mkdir(exist_ok=True)
                env[key] = str(path)
            env.update(PYTHONDONTWRITEBYTECODE='1', PXR_WORK_THREAD_LIMIT='1', OMP_NUM_THREADS='2')
            command = [sys.executable, '-B', str(Path(__file__).with_name('native_capture.py').resolve()),
                       '--project', str(args.project.resolve()), '--checkpoint', str(args.checkpoint.resolve()),
                       '--output', str(owner.directory), '--device', args.device, '--visualizer', 'none', '--steps', str(args.steps)]
            if args.reset_after:
                command.extend(['--reset-after', str(args.reset_after)])
            if args.metadata:
                command.extend(['--metadata', str(args.metadata.resolve())])
            try:
                owner.run(command, 'native', timeout=240, env=env)
            finally:
                after = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in protected}
                owner.ledger['source_files_unchanged'] = after == fingerprints
                owner.ledger['source_file_hashes'] = fingerprints
            owner.complete(snapshot=str(owner.directory / 'current-snapshot.json'))
            print(json.dumps({'snapshot': str(owner.directory / 'current-snapshot.json'), 'baseline': str(owner.directory / 'source-baseline.usdc')}))
        return 0
    if args.command == 'export':
        from scene import export_scene
        print(json.dumps(export_scene(args)))
        return 0
    value = json.loads(args.manifest.read_text())
    validate_manifest(value, args.manifest.parent)
    print(json.dumps({'status': 'valid', 'scene_hash': value.get('scene_hash')}))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except SourceToolError as error:
        print(json.dumps(error.report()), file=sys.stderr)
        raise SystemExit(2)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({'code': 'source_input_invalid', 'path': getattr(error, 'filename', None), 'message': str(error)}), file=sys.stderr)
        raise SystemExit(2)
    except KeyboardInterrupt:
        print(json.dumps({'code': 'source_tool_interrupted', 'message': 'Owned processes stopped; inspect the output ledger.'}), file=sys.stderr)
        raise SystemExit(130)
