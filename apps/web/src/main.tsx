import { createRoot } from "react-dom/client";
import { App } from "./shell/App.tsx";
import "./shell/theme.css";

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
