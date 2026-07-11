interface StatusDotProps {
  status: "online" | "away" | "offline";
}

const colors: Record<StatusDotProps["status"], string> = {
  online: "bg-emerald-400 shadow-[0_0_6px_theme(colors.emerald.400/0.6)]",
  away: "bg-amber-400 shadow-[0_0_6px_theme(colors.amber.400/0.6)]",
  offline: "bg-slate-500",
};

export default function StatusDot({ status }: StatusDotProps) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${colors[status]}`}
      title={status}
    />
  );
}
