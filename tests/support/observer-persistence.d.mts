type Status = { valid: boolean; category: 'observer_write_failed' | null };
export function observerWriter(
  publish: (status: Status, generation: number) => void,
  notify: (notice: { event: string; observerPersistence: Status }) => void,
): {
  status: () => Status;
  generation: () => number;
  markInvalid: () => void;
  save: () => void;
  finalNotice: () => void;
};
