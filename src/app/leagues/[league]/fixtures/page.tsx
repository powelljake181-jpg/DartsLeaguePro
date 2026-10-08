import type { Metadata } from "next";
import { FixturesView } from "./fixtures-view";

export const metadata: Metadata = { title: "Fixtures" };

export default async function FixturesPage(props: PageProps<"/leagues/[league]/fixtures">) {
  const { league } = await props.params;
  return <FixturesView slug={league} searchParams={props.searchParams} view="upcoming" />;
}
