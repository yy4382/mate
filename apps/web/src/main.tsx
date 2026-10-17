import { createRoot } from "react-dom/client";
import { App } from "./shell/App.tsx";
import "./shell/style.css";

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
