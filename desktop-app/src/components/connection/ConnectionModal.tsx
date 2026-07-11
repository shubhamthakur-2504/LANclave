interface ConnectionModalProps {
  isOpen: boolean;
  peerName: string;
  deviceName: string;
  ipAddress: string;
  onClose: () => void;
}

export default function ConnectionModal({
  isOpen,
  peerName,
  deviceName,
  ipAddress,
  onClose,
}: ConnectionModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl border border-slate-700/50 bg-slate-900 shadow-2xl shadow-sky-500/5">
        {/* Close button */}
        <div className="flex justify-end px-4 pt-4">
          <button
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-300"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="px-8 pb-8 pt-2 text-center">
          <h2 className="text-lg font-semibold text-slate-100">
            Connection Request
          </h2>

          {/* Peer avatar */}
          <div className="mx-auto mt-5 flex h-16 w-16 items-center justify-center rounded-full bg-sky-500/20 text-xl font-bold text-sky-400">
            {peerName[0]}
          </div>

          {/* Peer info */}
          <h3 className="mt-3 text-base font-semibold text-slate-100">
            {peerName}
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">
            {deviceName} &middot; {ipAddress}
          </p>

          {/* Security badge */}
          <div className="mx-auto mt-4 flex w-fit items-center gap-1.5 rounded-full border border-emerald-700/30 bg-emerald-950/30 px-3 py-1">
            <svg className="h-3.5 w-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" />
            </svg>
            <span className="text-[11px] font-medium text-emerald-400">
              AES-256 Encrypted
            </span>
          </div>

          {/* Buttons */}
          <div className="mt-6 flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 rounded-lg border border-red-800/50 px-4 py-2.5 text-sm font-medium text-red-400 transition-colors hover:bg-red-950/30"
            >
              Reject
            </button>
            <button className="flex-1 rounded-lg bg-sky-500 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-sky-400">
              Accept
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
