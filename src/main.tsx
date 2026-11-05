import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App.tsx";
import "./ui/styles.css";
import { engine } from "./audio/AudioEngine.ts";

// console/debug handle (used by the browser smoke test)
(window as unknown as { __chimeraEngine: typeof engine }).__chimeraEngine = engine;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
