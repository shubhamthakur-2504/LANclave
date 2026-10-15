import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import MirrorWindow from "./components/mirror/MirrorWindow";
import "./App.css";

// A phone-mirror window loads the same page with ?mirror=<session id>.
const mirrorSession = new URLSearchParams(window.location.search).get("mirror");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {mirrorSession ? <MirrorWindow sessionId={mirrorSession} /> : <App />}
  </React.StrictMode>,
);
