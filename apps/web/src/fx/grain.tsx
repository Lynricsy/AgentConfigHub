import { useEffect } from "react";
import type { ReactElement } from "react";

export function Grain(): ReactElement {
  useEffect(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.fx-grain");
    if (!canvas) return;

    let timer: ReturnType<typeof setTimeout> | null = null;

    function draw() {
      const w = Math.floor(window.innerWidth / 2);
      const h = Math.floor(window.innerHeight / 2);
      canvas!.width = w;
      canvas!.height = h;
      const ctx = canvas!.getContext("2d");
      if (!ctx) return;
      const img = ctx.createImageData(w, h);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = Math.random() * 255 | 0;
        d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    }

    draw();

    const onResize = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(draw, 150);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (timer !== null) clearTimeout(timer);
    };
  }, []);

  return <canvas className="fx-grain" aria-hidden="true" />;
}
