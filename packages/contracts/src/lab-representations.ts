// Generated from the native geometry owner. Run pnpm representations:generate.
export const labRepresentationProfiles = {
  format: 1,
  placement: {
    position: 'metres',
    rotation: 'radians',
    scale: 'positive multiplier; original GLB units are retained',
  },
  imported: {
    anchor: 'bounding-box X/Z centre and minimum Y; no rescaling',
  },
  profiles: {
    bench: {
      id: 'lab.native.v1.bench',
      units: 'm',
      anchor: 'base centre; y=0 support plane',
      bounds: {
        min: [-1.4, 0, -0.625],
        max: [1.4, 0.96, 0.625],
        size: [2.8, 0.96, 1.25],
      },
      worktopHeight: 0.96,
      meaning:
        'Representation dimensions, not a physical measurement or simulation',
    },
    light: {
      id: 'lab.native.v1.light',
      units: 'm',
      anchor: 'base centre; y=0 support plane',
      bounds: {
        min: [-0.3, 0, -0.3],
        max: [0.648857, 2.157275, 0.3],
        size: [0.948857, 2.157275, 0.6],
      },
      worktopHeight: null,
      meaning:
        'Representation dimensions, not a physical measurement or simulation',
    },
    sensor: {
      id: 'lab.native.v1.sensor',
      units: 'm',
      anchor: 'base centre; y=0 support plane',
      bounds: {
        min: [-0.14, 0, -0.077],
        max: [0.163, 0.41, 0.1025],
        size: [0.303, 0.41, 0.1795],
      },
      worktopHeight: null,
      meaning:
        'Representation dimensions, not a physical measurement or simulation',
    },
    robot: {
      id: 'lab.native.v1.robot',
      units: 'm',
      anchor: 'base centre; y=0 support plane',
      bounds: {
        min: [-0.49169, 0, -0.31],
        max: [0.440027, 1.56441, 0.31],
        size: [0.931717, 1.56441, 0.62],
      },
      worktopHeight: null,
      meaning:
        'Representation dimensions, not a physical measurement or simulation',
    },
    labware: {
      id: 'lab.native.v1.labware',
      units: 'm',
      anchor: 'base centre; y=0 support plane',
      bounds: {
        min: [-0.174, 0, -0.174],
        max: [0.174, 0.415, 0.174],
        size: [0.348, 0.415, 0.348],
      },
      worktopHeight: null,
      meaning:
        'Representation dimensions, not a physical measurement or simulation',
    },
    centrifuge: {
      id: 'lab.native.v1.centrifuge',
      units: 'm',
      anchor: 'base centre; y=0 support plane',
      bounds: {
        min: [-0.4655, 0, -0.4345],
        max: [0.4655, 0.611, 0.488],
        size: [0.931, 0.611, 0.9225],
      },
      worktopHeight: null,
      meaning:
        'Representation dimensions, not a physical measurement or simulation',
    },
    environment: {
      id: 'lab.native.v1.environment',
      units: 'm',
      anchor: 'base centre; y=0 support plane',
      bounds: {
        min: [-0.6, 0, -0.6],
        max: [0.6, 0.64, 0.6],
        size: [1.2, 0.64, 1.2],
      },
      worktopHeight: null,
      meaning:
        'Existing environment/location marker; no room dimensions or room identity',
    },
  },
} as const;
