import type { Metadata } from "next";
import { FixturesView } from "../fixtures/fixtures-view";

export const metadata: Metadata = { title: "Results" };

export default async function ResultsPage(props: PageProps<"/leagues/[league]/results">) {
  const { league } = await props.params;
  return <FixturesView slug={league} searchParams={props.searchParams} view="results" />;
}
