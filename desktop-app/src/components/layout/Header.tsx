export default function Header() {
  return (
    <header className="flex items-center justify-between border-b border-border px-6 py-3">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-action">
          LANclave
        </h1>
        <p className="text-[11px] text-content-faint">Secure LAN Sandbox Cloud</p>
      </div>
      <div className="flex items-center gap-2 rounded-full border border-border-strong bg-surface-raised px-4 py-1.5 text-xs text-ok">
        <span className="h-1.5 w-1.5 rounded-full bg-ok shadow-[0_0_6px_theme(colors.emerald.400/0.6)]" />
        System Active
      </div>
    </header>
  );
}
