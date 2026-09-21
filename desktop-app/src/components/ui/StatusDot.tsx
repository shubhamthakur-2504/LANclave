interface StatusDotProps {
  status: "online" | "away" | "offline";
}

const colors: Record<StatusDotProps["status"], string> = {
  online: "bg-ok shadow-[0_0_6px_theme(colors.emerald.400/0.6)]",
  away: "bg-warn shadow-[0_0_6px_theme(colors.amber.400/0.6)]",
  offline: "bg-content-faint",
};

export default function StatusDot({ status }: StatusDotProps) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${colors[status]}`}
      title={status}
    />
  );
}
