import { Field, Input } from "./ui";

/** Shared season form fields (create and edit). */
export function SeasonFields({
  defaults,
}: {
  defaults?: { name: string; startsOn: string; endsOn: string; registrationDeadline: string; maxSquadSize: string };
}) {
  return (
    <>
      <Field label="Season name" htmlFor="season-name">
        <Input id="season-name" name="name" placeholder="2026/27" defaultValue={defaults?.name} required />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Starts" htmlFor="season-start">
          <Input id="season-start" name="startsOn" type="date" defaultValue={defaults?.startsOn} required />
        </Field>
        <Field label="Ends (optional)" htmlFor="season-end">
          <Input id="season-end" name="endsOn" type="date" defaultValue={defaults?.endsOn} />
        </Field>
      </div>
      <Field
        label="Registration deadline"
        htmlFor="season-deadline"
        hint="Team captains can't add players after the end of this day. League admins can still add players. Leave blank for no deadline."
      >
        <Input id="season-deadline" name="registrationDeadline" type="date" defaultValue={defaults?.registrationDeadline} />
      </Field>
      <Field label="Maximum squad size (optional)" htmlFor="season-squad">
        <Input id="season-squad" name="maxSquadSize" type="number" min={1} max={100} inputMode="numeric" defaultValue={defaults?.maxSquadSize} />
      </Field>
    </>
  );
}
