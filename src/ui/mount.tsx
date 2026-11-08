import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { useStore } from "./store.ts";
import { engine } from "../audio/AudioEngine.ts";

export function mount(root: HTMLElement): void {
  // console/debug handle (used by the browser smoke test)
  (window as unknown as { __chimeraEngine: typeof engine }).__chimeraEngine = engine;
  if (new URLSearchParams(window.location.search).get("mode") === "speak") {
    useStore.getState().setMode("speak");
  }
  root.replaceChildren();
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
