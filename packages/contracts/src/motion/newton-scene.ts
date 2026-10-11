/** Fixed scene asset lookup; server validates exact bytes again at installation. */
export const NEWTON_SCENE_VISUALS = [
  {
    pose_key: 'so101/base',
    sha256: '89f44fe3e067a7b87bdf00b370e963825836fd2fae323d0550aabf66353a1143',
  },
  {
    pose_key: 'so101/shoulder',
    sha256: '23d9830c724fd2d116b34da1bab660692dd3a3d88a5b4ba2474a7431f0ee95d6',
  },
  {
    pose_key: 'so101/upper_arm',
    sha256: '5534d2f09cedb5dde115fbf6aae398f77d39d8cf7eca571a99020b14a844cd42',
  },
  {
    pose_key: 'so101/lower_arm',
    sha256: '189a5b59d19c0f2929c7403d3eb0b9b6cb58f0b680003fa8a1e849063396326e',
  },
  {
    pose_key: 'so101/wrist',
    sha256: '3ecabb0165a92cffd41d23700c0bee6a805c200b1e1292b22527870400d22ede',
  },
  {
    pose_key: 'so101/gripper',
    sha256: '9ba090a3255d211d567dee136c4275fc4316217a71906f2d3939932af6150c9e',
  },
  {
    pose_key: 'so101/moving_jaw_so101_v1',
    sha256: 'f00b1c46e9bd5421f6310514d972d09f095cf72a7881cbd474bf7f77b8f94ccc',
  },
  {
    pose_key: 'vial',
    sha256: 'aeecb3397ffe7906e0f13c8691e1c05dd36598a0e281725b250803ddb5b1c15a',
  },
  {
    pose_key: 'rack',
    sha256: '51e7581562c93918ef8578650936ec1b11300cc8d6fbbc4eff73a3ce22f94f44',
  },
  {
    pose_key: 'mat',
    sha256: '0695df4ad71935279ed2d7c45f8be514f48190ab5fc8fdfc8237d97d7e649474',
  },
] as const;
