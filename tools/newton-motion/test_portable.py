"""Portable coordinate, source provenance and bounded custody checks; no GPU imports."""
import math
from pathlib import Path
import tempfile
import time
import unittest

from coordinates import native_pose, wire_pose
from facts_owner import PhysicsOwner
from scene_loader import archive_bytes, extract_scene, supported_profile
from prepare import prepare
from budget import NativeBudgetError, validate_native_budget


class Run:
    def __init__(self): self.steps=0
    def step(self): self.steps+=8
    def sample(self): return {'sim_time_ns':self.steps*1_000_000_000//240}


class PortableTests(unittest.TestCase):
    def test_native_budget_rejects_actual_sdk_growth_unknown_counts_and_substep_overflow(self):
        valid={'nworld':1,'naconmax':256,'njmax':512,'nacon':12,'ncollision':8,'nefc':10,'overflow':0,'cpu_ncon':12,'cpu_nefc':10}
        validate_native_budget(valid,'constructor',initial=True)
        for change in [{'naconmax':267,'nacon':267},{'ncollision':257},{'nefc':513},{'overflow':1}]:
            with self.assertRaises(NativeBudgetError):validate_native_budget({**valid,**change},'actual-native-substep',initial=True)
        unknown={k:v for k,v in valid.items() if k!='ncollision'}
        with self.assertRaisesRegex(NativeBudgetError,'missing actual getters'):
            validate_native_budget(unknown,'constructor',initial=True)
    def test_production_package_extracts_exact_maker_and_derived_allowlist_without_solver(self):
        import hashlib
        import json
        import sys
        profile=supported_profile()
        base=Path(__file__).parent/'scene/representations/base.glb'
        with tempfile.TemporaryDirectory() as parent:
            scene=extract_scene(base,Path(parent),profile)
            actual={p.relative_to(scene).as_posix() for p in scene.rglob('*') if p.is_file()}
            self.assertEqual(actual,{entry['path'] for entry in profile['physics_archive']['members']})
            derived=[name for name in actual if name.endswith('.obj')]
            self.assertEqual(len(derived),11)
            self.assertEqual(sum(entry['bytes'] for entry in profile['physics_archive']['members']),19_058_074)
            for entry in profile['physics_archive']['members']:
                data=(scene/entry['path']).read_bytes()
                self.assertEqual(len(data),entry['bytes'])
                self.assertEqual('sha256:'+hashlib.sha256(data).hexdigest(),entry['sha256'])
            provenance=json.loads((scene/'moving-compound.json').read_text())
            self.assertIsNone(provenance['derived_upstream_url'])
            self.assertTrue(provenance['original_visuals_and_stls_retained'])
            self.assertEqual(json.loads((scene/'program.json').read_text()),profile['program'])
        self.assertNotIn('newton',sys.modules)
        self.assertNotIn('warp',sys.modules)

    def test_materialization_rejects_existing_user_output_without_overwrite(self):
        with tempfile.TemporaryDirectory() as parent:
            output=Path(parent)/'existing';output.mkdir();sentinel=output/'keep.txt';sentinel.write_text('user data')
            with self.assertRaises(FileExistsError):prepare(output)
            self.assertEqual(sentinel.read_text(),'user data')

    def test_world_basis_uses_right_handed_y_up_and_quaternion_conjugation(self):
        pose=wire_pose((1,2,3),(0,0,0,1))
        for actual,expected in zip(pose['position'],(1,3,-2),strict=True):self.assertAlmostEqual(actual,expected)
        quarter=wire_pose((0,0,0),(0,0,math.sqrt(.5),math.sqrt(.5)))
        for actual,expected in zip(quarter['quaternion'],(0,math.sqrt(.5),0,math.sqrt(.5)),strict=True):self.assertAlmostEqual(actual,expected)
        restored=native_pose(pose['position'],pose['quaternion'])
        for actual,expected in zip(restored['position'],(1,2,3),strict=True):self.assertAlmostEqual(actual,expected)

    def test_changed_or_stripped_physics_container_is_rejected_before_solver_import(self):
        import sys
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'base.glb';path.write_bytes(b'glTF'+b'\0'*64)
            with self.assertRaisesRegex(ValueError,'changed or archive stripped'):
                archive_bytes(path,supported_profile())
        self.assertNotIn('newton',sys.modules)

    def test_selected_fact_capacity_counts_unsent_and_sent_unacked_facts_together(self):
        run=Run();owner=PhysicsOwner(run,lambda sample,sequence:bytes([sequence]),{'source_frames':2,'source_bytes':16,'durability_timeout_ms':1000})
        try:
            deadline=time.monotonic()+2
            while owner.take() is None:
                self.assertLess(time.monotonic(),deadline);time.sleep(.001)
            owner.resume()
            while True:
                try:owner.take()
                except RuntimeError as error:
                    self.assertIn('capacity',str(error));break
                self.assertLess(time.monotonic(),deadline);time.sleep(.001)
            stopped=run.steps;time.sleep(.04);self.assertEqual(run.steps,stopped)
        finally:owner.close()

    def test_pause_boundary_keeps_simulation_time_and_ack_releases_custody(self):
        run=Run();owner=PhysicsOwner(run,lambda sample,sequence:bytes([sequence]),{'source_frames':2,'source_bytes':16,'durability_timeout_ms':1000})
        try:
            deadline=time.monotonic()+2
            first=None
            while first is None:
                first=owner.take();self.assertLess(time.monotonic(),deadline);time.sleep(.001)
            owner.ack(first[0])
            boundary=owner.boundary()
            self.assertEqual(boundary[:2],(2,0));self.assertEqual(run.steps,0)
            owner.ack(boundary[0])
            next_boundary=owner.boundary()
            self.assertEqual(next_boundary[:2],(3,0))
        finally:owner.close()


if __name__=='__main__':unittest.main()
