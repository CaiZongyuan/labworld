/** Fixed scene asset lookup; server validates exact bytes again at installation. */
export const NEWTON_SCENE_VISUALS = [
  {
    pose_key: 'so101/base',
    sha256: '1f914ad6176fd3a16e22c6c8c99f2dd09eef7fb253d68c8cc56ab02641e544de',
  },
  {
    pose_key: 'so101/shoulder',
    sha256: 'f2ff510f80304b5d291e476bc6ba224dcbbddbffd8268b4845b53e39e27a803a',
  },
  {
    pose_key: 'so101/upper_arm',
    sha256: 'fa34d7e14c1ad2a2e185d66a88bd1d5893267bf02ffc6e3eb76b0800622e264c',
  },
  {
    pose_key: 'so101/lower_arm',
    sha256: 'f830f0c1c29988e177f992689773cae26a6f906744fbb1d09eddec4fd1f0a00e',
  },
  {
    pose_key: 'so101/wrist',
    sha256: '934276ddc39aafff7f676f8e654e71b33b64c187639aa889960cd7fa8aea5656',
  },
  {
    pose_key: 'so101/gripper',
    sha256: 'd9d157121685a4192892e349c205fbe4c24261feeb0f2f992f949ca54e9b22f1',
  },
  {
    pose_key: 'so101/moving_jaw_so101_v1',
    sha256: 'b963c11bf304debeac8986310e5b6fe0738fca432e7a716a5ececf115af7fd4a',
  },
  {
    pose_key: 'vial',
    sha256: '51be8249d077391343da941512b757592d515b55a41332fc7cdb78002decdd4c',
  },
  {
    pose_key: 'rack',
    sha256: '267416c4dc0c18c50f4cc18d2bf01eb4f1e02b45e180c9a625a84a0318aab0cd',
  },
  {
    pose_key: 'mat',
    sha256: '81c577f75c2d1cc967e2f90ae9936854fbaccb5250146d85d931a37083e7df46',
  },
] as const;
