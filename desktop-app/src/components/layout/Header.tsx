export default function Header() {
  return (
    <header className="flex items-center justify-between border-b border-slate-800 px-6 py-3">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-sky-400">
          LANclave
        </h1>
        <p className="text-[11px] text-slate-500">Secure LAN Sandbox Cloud</p>
      </div>
      <div className="flex items-center gap-2 rounded-full border border-slate-700/50 bg-slate-900 px-4 py-1.5 text-xs text-emerald-400">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_theme(colors.emerald.400/0.6)]" />
        System Active
      </div>
    </header>
  );
}
