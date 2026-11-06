import { useEffect, useRef } from "react";
import * as THREE from "three";

/** The original Nexus particle field: a slowly rotating cyan point cloud over radial glows. */
export default function NeuralMeshBackground() {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    } catch {
      return; // no WebGL: the radial glows alone still render
    }
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    const count = 600;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count * 3; i += 1) positions[i] = (Math.random() - 0.5) * 5;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({ size: 0.006, color: 0x00d2ff, transparent: true, opacity: 0.8 });
    const points = new THREE.Points(geometry, material);
    scene.add(points);
    camera.position.z = 2;

    const clock = new THREE.Clock();
    let frame = 0;
    const animate = () => {
      const t = clock.getElapsedTime();
      points.rotation.y = t * 0.05;
      points.rotation.x = t * 0.02;
      renderer.render(scene, camera);
      if (!reduced) frame = window.requestAnimationFrame(animate);
    };
    animate();
    const onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      if (reduced) renderer.render(scene, camera);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.cancelAnimationFrame(frame);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden="true">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(0,210,255,0.12),transparent_42%),radial-gradient(circle_at_bottom,rgba(112,0,255,0.10),transparent_36%)]" />
      <div ref={mountRef} className="absolute inset-0" />
    </div>
  );
}
