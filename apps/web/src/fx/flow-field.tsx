import { useEffect } from "react";
import type { ReactElement } from "react";
import { useReducedMotion } from "motion/react";

export function FlowField(): ReactElement {
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) return;
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.fx-flow");
    if (!canvas) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let rafId = 0;
    let t = 0;
    let running = true;

    const ctx = canvas.getContext("2d")!;

    function resize() {
      canvas!.width = window.innerWidth * dpr;
      canvas!.height = window.innerHeight * dpr;
      // reset transform after every resize (canvas resize clears it)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();

    // parse CSS tokens once
    const style = getComputedStyle(document.documentElement);
    const volt = style.getPropertyValue("--volt").trim() || "#c6f75e";
    const signal = style.getPropertyValue("--signal").trim() || "#54e0ff";

    const W = () => window.innerWidth;
    const H = () => window.innerHeight;

    const particles = Array.from({ length: 60 }, (_, i) => ({
      x: Math.random() * W(),
      y: Math.random() * H(),
      px: 0,
      py: 0,
      color: i < 45 ? volt : signal,
    }));
    for (const p of particles) { p.px = p.x; p.py = p.y; }

    function tick() {
      const w = W(); const h = H();
      ctx.fillStyle = "rgba(2,4,6,.055)";
      ctx.fillRect(0, 0, w, h);
      ctx.lineWidth = 0.7;
      ctx.globalAlpha = 0.5;
      for (const p of particles) {
        p.px = p.x; p.py = p.y;
        const a = Math.sin(p.x * 0.0016 + t) * Math.cos(p.y * 0.0016 + t * 0.7) * Math.PI * 2;
        p.x += Math.cos(a) * 1.15;
        p.y += Math.sin(a) * 1.15;
        if (p.x < 0 || p.x > w || p.y < 0 || p.y > h) {
          p.x = Math.random() * w;
          p.y = Math.random() * h;
          p.px = p.x; p.py = p.y;
        }
        ctx.strokeStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(p.px, p.py);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      t += 0.0022;
      rafId = requestAnimationFrame(tick);
    }

    function pause() {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    function resume() {
      if (rafId === 0 && running) rafId = requestAnimationFrame(tick);
    }

    const onVisibility = () => {
      if (document.visibilityState === "hidden") pause();
      else resume();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("resize", resize);

    rafId = requestAnimationFrame(tick);

    return () => {
      running = false;
      cancelAnimationFrame(rafId);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", resize);
    };
  }, [reduced]);

  return <canvas className="fx-flow" aria-hidden="true" />;
}
