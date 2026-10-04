import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Crosshair, Minus, Plus } from 'lucide-react';
import { Button } from '@labos-threejs/ui/components/button';
import type { Device } from './model';
import { attention, reading } from './model';

export default function Space({
  devices,
  dark,
  onSelect,
}: {
  devices: Device[];
  dark: boolean;
  onSelect: (id: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const current = useRef(devices);
  const select = useRef(onSelect);
  const api = useRef<{
    fit: () => void;
    zoom: (factor: number) => void;
  } | null>(null);
  const [failure, setFailure] = useState(false);
  current.current = devices;
  select.current = onSelect;

  useEffect(() => {
    const element = host.current!;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(dark ? '#212426' : '#f2f5f5');
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        preserveDrawingBuffer: true,
      });
    } catch {
      setFailure(true);
      return;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.setAttribute('aria-label', '实验室三维空间');
    element.prepend(renderer.domElement);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2.1;
    controls.minDistance = 6;
    controls.maxDistance = 28;
    const fit = () => {
      camera.position.set(10, 10, 12);
      controls.target.set(0, 0.9, 0);
      controls.update();
    };
    fit();
    api.current = {
      fit,
      zoom: (factor) => {
        camera.position
          .sub(controls.target)
          .multiplyScalar(factor)
          .add(controls.target);
        controls.update();
      },
    };
    scene.add(new THREE.HemisphereLight(0xffffff, 0x879093, 2.6));
    const sun = new THREE.DirectionalLight(0xffffff, 3);
    sun.position.set(3, 10, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -8;
    sun.shadow.camera.right = 8;
    sun.shadow.camera.top = 8;
    sun.shadow.camera.bottom = -8;
    sun.shadow.bias = -0.001;
    scene.add(sun);
    const material = (color: number, roughness = 0.65) =>
      new THREE.MeshStandardMaterial({ color, roughness });
    const offwhite = material(dark ? 0x747d7e : 0xf7f9f8),
      teal = material(0x408e87),
      metal = material(0x899b9c, 0.4),
      black = material(0x34474b);
    const mesh = (
      geometry: THREE.BufferGeometry,
      mat: THREE.Material,
      parent: THREE.Object3D,
      position: number[],
    ) => {
      const object = new THREE.Mesh(geometry, mat);
      object.position.set(position[0], position[1], position[2]);
      object.castShadow = true;
      object.receiveShadow = true;
      parent.add(object);
      return object;
    };
    mesh(
      new THREE.BoxGeometry(9.6, 0.15, 7.6),
      material(dark ? 0x394144 : 0xe6eded),
      scene,
      [0, -0.1, 0],
    );
    const grid = new THREE.GridHelper(
      9,
      18,
      dark ? 0x4c585b : 0xc5d2d3,
      dark ? 0x404b4d : 0xd3ddde,
    );
    grid.position.y = 0;
    scene.add(grid);
    mesh(new THREE.BoxGeometry(9.6, 2, 0.12), offwhite, scene, [0, 1, -3.8]);
    mesh(new THREE.BoxGeometry(0.12, 2, 7.6), offwhite, scene, [-4.8, 1, 0]);
    for (const x of [-2.2, 2.2]) {
      mesh(new THREE.BoxGeometry(3.6, 0.18, 1.8), offwhite, scene, [
        x,
        1.25,
        0,
      ]);
      for (const dx of [-1.5, 1.5])
        for (const dz of [-0.65, 0.65])
          mesh(new THREE.BoxGeometry(0.13, 1.2, 0.13), metal, scene, [
            x + dx,
            0.6,
            dz,
          ]);
      mesh(new THREE.BoxGeometry(3.3, 0.65, 0.8), offwhite, scene, [
        x,
        0.8,
        -0.3,
      ]);
    }
    const objects: {
      group: THREE.Group;
      id: string;
      rotor?: THREE.Group;
      bulb?: THREE.Mesh;
      light?: THREE.PointLight;
      ring: THREE.Mesh;
    }[] = [];
    const positions = [
      [1.25, 1.4, 0.1],
      [3, 1.4, 0.1],
      [-3, 1.4, 0.2],
      [2.3, 1.4, -0.6],
      [-1.25, 1.4, -0.25],
      [3.65, 1.4, -0.6],
      [-2.2, 1.4, -0.5],
    ];
    for (const [index, device] of devices.entries()) {
      const group = new THREE.Group();
      group.position.set(...(positions[index] as [number, number, number]));
      group.userData.entityId = device.id;
      scene.add(group);
      let rotor: THREE.Group | undefined,
        bulb: THREE.Mesh | undefined,
        light: THREE.PointLight | undefined;
      if (device.kind === 'centrifuge') {
        mesh(
          new THREE.CylinderGeometry(0.47, 0.52, 0.52, 40),
          offwhite,
          group,
          [0, 0.26, 0],
        );
        mesh(
          new THREE.CylinderGeometry(0.46, 0.46, 0.1, 40),
          teal,
          group,
          [0, 0.56, 0],
        );
        mesh(
          new THREE.CylinderGeometry(0.32, 0.32, 0.04, 32),
          black,
          group,
          [0, 0.63, 0],
        );
        rotor = new THREE.Group();
        rotor.position.y = 0.67;
        group.add(rotor);
        for (let j = 0; j < 4; j++) {
          const arm = mesh(
            new THREE.BoxGeometry(0.1, 0.035, 0.55),
            metal,
            rotor,
            [0, 0, 0],
          );
          arm.rotation.y = (j * Math.PI) / 4;
        }
        const screen = mesh(
          new THREE.BoxGeometry(0.2, 0.1, 0.04),
          black,
          group,
          [0, 0.29, 0.49],
        );
        screen.rotation.x = -0.2;
      } else if (device.kind === 'sensor') {
        mesh(
          new THREE.BoxGeometry(0.28, 0.44, 0.2),
          device.reality === 'physical' ? metal : offwhite,
          group,
          [0, 0.22, 0],
        );
        mesh(
          new THREE.BoxGeometry(0.18, 0.14, 0.025),
          teal,
          group,
          [0, 0.28, 0.12],
        );
        mesh(
          new THREE.CylinderGeometry(0.035, 0.035, 0.38, 12),
          metal,
          group,
          [0, 0.62, 0],
        );
      } else {
        mesh(
          new THREE.CylinderGeometry(0.18, 0.22, 0.08, 24),
          teal,
          group,
          [0, 0.04, 0],
        );
        mesh(
          new THREE.CylinderGeometry(0.04, 0.04, 1.1, 12),
          metal,
          group,
          [0, 0.59, 0],
        );
        mesh(
          new THREE.BoxGeometry(0.85, 0.1, 0.3),
          teal,
          group,
          [-0.28, 1.13, 0],
        );
        bulb = mesh(
          new THREE.BoxGeometry(0.72, 0.025, 0.22),
          material(0xffefb1),
          group,
          [-0.28, 1.07, 0],
        );
        light = new THREE.PointLight(0xffe0a0, 0, 2);
        light.position.set(-0.28, 0.95, 0);
        group.add(light);
      }
      const ring = mesh(
        new THREE.RingGeometry(0.55, 0.58, 40),
        new THREE.MeshBasicMaterial({
          color: 0x2c998c,
          side: THREE.DoubleSide,
        }),
        group,
        [0, 0.015, 0],
      );
      ring.rotation.x = -Math.PI / 2;
      objects.push({ group, id: device.id, rotor, bulb, light, ring });
    }
    const resize = () => {
      const width = element.clientWidth,
        height = element.clientHeight;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      if (width < 550) {
        camera.position.set(13, 15, 18);
        controls.target.set(0, 1, 0);
      }
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    const raycaster = new THREE.Raycaster();
    let downX = 0,
      downY = 0;
    const down = (event: PointerEvent) => {
      downX = event.clientX;
      downY = event.clientY;
    };
    const up = (event: PointerEvent) => {
      if (Math.hypot(event.clientX - downX, event.clientY - downY) > 5) return;
      const rect = renderer.domElement.getBoundingClientRect();
      raycaster.setFromCamera(
        new THREE.Vector2(
          ((event.clientX - rect.left) / rect.width) * 2 - 1,
          (-(event.clientY - rect.top) / rect.height) * 2 + 1,
        ),
        camera,
      );
      const hit = raycaster.intersectObjects(
        objects.map((object) => object.group),
        true,
      )[0];
      if (!hit) return;
      let object: THREE.Object3D | null = hit.object;
      while (object && !object.userData.entityId) object = object.parent;
      if (object) select.current(object.userData.entityId);
    };
    renderer.domElement.addEventListener('pointerdown', down);
    renderer.domElement.addEventListener('pointerup', up);
    let frame = 0;
    const animate = () => {
      controls.update();
      const labelBoxes: {
        left: number;
        top: number;
        right: number;
        bottom: number;
      }[] = [];
      for (const object of objects) {
        const device = current.current.find((entry) => entry.id === object.id)!;
        if (
          object.rotor &&
          device.fresh === 'current' &&
          device.run === 'running'
        )
          object.rotor.rotation.y += (device.value ?? 0) / 24000;
        if (object.light)
          object.light.intensity =
            device.fresh === 'current' && device.on ? 2 : 0;
        if (object.bulb)
          (object.bulb.material as THREE.MeshStandardMaterial).emissive.setHex(
            device.on && device.fresh === 'current' ? 0xa29051 : 0x000000,
          );
        (object.ring.material as THREE.MeshBasicMaterial).color.setHex(
          attention(device)
            ? 0xc68737
            : device.reality === 'physical'
              ? 0x8b979a
              : 0x2c998c,
        );
        const label = element.querySelector<HTMLElement>(
          `[data-label="${object.id}"]`,
        );
        if (label && label.offsetWidth) {
          const point = object.group.position
            .clone()
            .add(new THREE.Vector3(0, device.kind === 'light' ? 1.5 : 1, 0))
            .project(camera);
          const width = label.offsetWidth,
            height = label.offsetHeight;
          const x = Math.max(
            width / 2 + 10,
            Math.min(
              element.clientWidth - width / 2 - 10,
              (point.x * 0.5 + 0.5) * element.clientWidth,
            ),
          );
          const anchor = (-point.y * 0.5 + 0.5) * element.clientHeight;
          let top = Math.max(55, anchor - height);
          for (let attempt = 0; attempt < objects.length; attempt++) {
            const overlap = labelBoxes.find(
              (box) =>
                x + width / 2 + 6 > box.left &&
                x - width / 2 - 6 < box.right &&
                top + height + 6 > box.top &&
                top - 6 < box.bottom,
            );
            if (!overlap) break;
            top = overlap.top - height - 8;
          }
          labelBoxes.push({
            left: x - width / 2,
            right: x + width / 2,
            top,
            bottom: top + height,
          });
          label.style.left = `${x}px`;
          label.style.top = `${top + height}px`;
          label.style.setProperty(
            '--leader-height',
            `${Math.max(0, anchor - top - height)}px`,
          );
        }
      }
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    animate();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener('pointerdown', down);
      renderer.domElement.removeEventListener('pointerup', up);
      const materials = new Set<THREE.Material>();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const list = Array.isArray(object.material)
            ? object.material
            : [object.material];
          list.forEach((mat) => materials.add(mat));
        }
      });
      materials.forEach((mat) => mat.dispose());
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.domElement.remove();
      api.current = null;
    };
  }, [dark, devices.length]);

  return (
    <section className="space-section">
      <div className="space-canvas" ref={host}>
        {failure ? <div className="space-failure">三维视图不可用</div> : null}
        <div className="space-toolbar">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="适配整个实验室"
            title="适配整个实验室"
            onClick={() => api.current?.fit()}
          >
            <Crosshair />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="放大"
            title="放大"
            onClick={() => api.current?.zoom(0.85)}
          >
            <Plus />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="缩小"
            title="缩小"
            onClick={() => api.current?.zoom(1.15)}
          >
            <Minus />
          </Button>
        </div>
        <div className="space-location prepare-label">准备区</div>
        <div className="space-location instrument-label">仪器区</div>
        {devices
          .filter((device) => device.kind !== 'light')
          .map((device) => (
            <button
              key={device.id}
              data-label={device.id}
              className={`space-device-label ${attention(device) ? 'label-attention' : ''}`}
              onClick={() => onSelect(device.id)}
              aria-label={`在空间中查看${device.name}`}
            >
              <span>{device.name}</span>
              <strong>
                {reading(device).value}
                <small>{reading(device).unit}</small>
              </strong>
            </button>
          ))}
        <div className="space-legend">
          <span>
            <i className="dot teal" />
            当前观测
          </span>
          <span>
            <i className="dot amber" />
            待关注
          </span>
          <span>
            <i className="dot neutral" />
            尚未接入
          </span>
        </div>
      </div>
      <div className="space-device-strip">
        {devices.map((device) => (
          <button key={device.id} onClick={() => onSelect(device.id)}>
            <span
              className={`dot ${attention(device) ? 'amber' : device.run === 'unbound' ? 'neutral' : 'teal'}`}
            />
            <strong>{device.name}</strong>
            <small>{device.location}</small>
          </button>
        ))}
      </div>
    </section>
  );
}
