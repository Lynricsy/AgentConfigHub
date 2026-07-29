import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  return (
    <main>
      <p className="eyebrow">Self-hosted configuration control plane</p>
      <h1>AgentConfigHub</h1>
      <p>The administration interface is under development.</p>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(<StrictMode><App /></StrictMode>);
