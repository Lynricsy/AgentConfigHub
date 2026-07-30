import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import Lenis from "lenis";

import { App } from "./app.js";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 5_000 },
    mutations: { retry: false },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter><App /></BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

// Step 15 — Lenis smooth scroll on .route-content
// .route-content は AuthGate 通過後にのみ挿入されるため、
// MutationObserver で要素の挿入を監視して一度だけ初期化する。
let _lenisRaf: number | null = null;
let _lenis: Lenis | null = null;

function initLenis(el: HTMLElement): void {
  if (_lenis) return;
  _lenis = new Lenis({ wrapper: el, content: el });
  const raf = (time: number) => {
    _lenis!.raf(time);
    _lenisRaf = requestAnimationFrame(raf);
  };
  _lenisRaf = requestAnimationFrame(raf);
}

// MutationObserver で .route-content の DOM 挿入を待つ
const _lenisObserver = new MutationObserver(() => {
  const el = document.querySelector(".route-content") as HTMLElement | null;
  if (el) {
    _lenisObserver.disconnect();
    initLenis(el);
  }
});
_lenisObserver.observe(document.body, { childList: true, subtree: true });

// すでに DOM に存在する場合は即座に初期化（画面リロード時など）
{
  const el = document.querySelector(".route-content") as HTMLElement | null;
  if (el) {
    _lenisObserver.disconnect();
    initLenis(el);
  }
}

// HMR dispose：Vite 热更新前取消 RAF、销毁 Lenis、断开 Observer
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    _lenisObserver.disconnect();
    if (_lenisRaf !== null) {
      cancelAnimationFrame(_lenisRaf);
      _lenisRaf = null;
    }
    _lenis?.destroy();
    _lenis = null;
  });
}
