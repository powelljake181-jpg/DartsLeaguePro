import { Field, Input } from "@/components/ui";

/** Date + time inputs, interpreted in the league's timezone by the action. */
export function DateTimeFields({ date, time, idPrefix }: { date: string; time: string; idPrefix: string }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="New date" htmlFor={`${idPrefix}-date`}>
        <Input id={`${idPrefix}-date`} name="date" type="date" defaultValue={date} required />
      </Field>
      <Field label="Time" htmlFor={`${idPrefix}-time`}>
        <Input id={`${idPrefix}-time`} name="time" type="time" defaultValue={time} required />
      </Field>
    </div>
  );
}

export const ReasonField = ({ id, hint = "Both teams will see this." }: { id: string; hint?: string }) => (
  <Field label="Reason" htmlFor={id} hint={hint}>
    <Input id={id} name="reason" required maxLength={500} />
  </Field>
);
