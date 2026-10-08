import { asc, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { leagues } from "@/db/schema";
import { Card, EmptyState, List, Page, PageHeader, RowLink } from "@/components/ui";

/** Public home: every league, each linking to its tables, fixtures, results and stats. */
export default async function Home() {
  const db = await getDb();
  const all = await db.select().from(leagues).where(isNull(leagues.archivedAt)).orderBy(asc(leagues.name));
  return (
    <Page>
      <PageHeader title="Leagues" subtitle="Fixtures, results, tables and live scores." />
      <Card>
        {all.length ? (
          <List>
            {all.map((l) => (
              <RowLink key={l.id} href={`/leagues/${l.slug}`} title={l.name} meta="Tables, fixtures, results and player stats" />
            ))}
          </List>
        ) : (
          <EmptyState>No leagues yet.</EmptyState>
        )}
      </Card>
    </Page>
  );
}
