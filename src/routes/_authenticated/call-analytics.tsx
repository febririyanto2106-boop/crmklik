/**
 * Call Analytics — translated voice/video calls.
 *
 * Reads everything from the call logs already written into the inbox, so this
 * page needs no new tracking and works retroactively on calls made before it
 * existed.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Clock,
  Download,
  Languages,
  PhoneCall,
  PhoneMissed,
  RefreshCw,
  Timer,
  Users,
  Video,
} from "lucide-react";
import { AppTopbar } from "@/components/app/app-topbar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getCallAnalytics, type CallAnalytics } from "@/lib/calls/analytics.functions";

export const Route = createFileRoute("/_authenticated/call-analytics")({
  head: () => ({
    meta: [
      { title: "Call Analytics" },
      {
        name: "description",
        content:
          "Answered and missed translated calls, talk time, language pairs and per-agent performance.",
      },
    ],
  }),
  component: CallAnalyticsPage,
});

const PALETTE = ["#075E54", "#25D366", "#6366F1", "#F59E0B", "#0EA5E9", "#EF4444", "#10B981"];

function fmtSec(sec: number): string {
  if (!sec || sec < 1) return "—";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${sec % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function KpiCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof PhoneCall;
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <Card className="border">
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase text-muted-foreground">{label}</span>
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="mt-2 text-2xl font-semibold">{value}</div>
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

function downloadCsv(name: string, rows: Array<Record<string, unknown>>) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function CallAnalyticsPage() {
  const [days, setDays] = useState(30);
  const q = useQuery<CallAnalytics>({
    queryKey: ["call-analytics", days],
    queryFn: () => getCallAnalytics({ data: { days } }),
  });

  const d = q.data;
  const t = d?.totals;
  const noCalls = !q.isLoading && t && t.answered === 0 && t.missed === 0;

  return (
    <div className="flex flex-1 flex-col">
      <AppTopbar
        title="Call Analytics"
        subtitle="Translated voice & video calls — volume, talk time, languages and agents"
        actions={
          <div className="flex items-center gap-2">
            <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
              <SelectTrigger className="h-9 w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
                <SelectItem value="365">Last year</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void q.refetch()}
              disabled={q.isFetching}
            >
              <RefreshCw className={`h-4 w-4 ${q.isFetching ? "animate-spin" : ""}`} />
            </Button>
          </div>
        }
      />

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {q.isError && (
          <Card>
            <CardContent className="p-6 text-sm text-destructive">
              Could not load call analytics.{" "}
              {q.error instanceof Error ? q.error.message : "Please try again."}
            </CardContent>
          </Card>
        )}

        {noCalls && (
          <Card>
            <CardContent className="p-10 text-center">
              <PhoneCall className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-3 text-sm font-medium">No calls in this period</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Start a translated call from any conversation and it will appear here.
              </p>
            </CardContent>
          </Card>
        )}

        {t && !noCalls && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <KpiCard
                icon={PhoneCall}
                label="Answered"
                value={t.answered}
                hint={`${t.videoCalls} video · ${t.answered - t.videoCalls} voice`}
              />
              <KpiCard
                icon={PhoneMissed}
                label="Missed"
                value={t.missed}
                hint={`${t.answerRate}% answer rate`}
              />
              <KpiCard
                icon={Clock}
                label="Total talk time"
                value={fmtSec(t.talkTimeSec)}
                hint={`Longest ${fmtSec(t.longestSec)}`}
              />
              <KpiCard
                icon={Timer}
                label="Average call"
                value={fmtSec(t.avgDurationSec)}
                hint={`${t.recordedRate}% recorded (${t.recorded})`}
              />
            </div>

            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">Calls per day</CardTitle>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => downloadCsv("calls-daily.csv", d.daily)}
                >
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  CSV
                </Button>
              </CardHeader>
              <CardContent className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={d.daily}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.3} />
                    <XAxis dataKey="date" fontSize={11} tickFormatter={(v: string) => v.slice(5)} />
                    <YAxis fontSize={11} allowDecimals={false} />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="answered" name="Answered" stackId="a" fill={PALETTE[0]} />
                    <Bar dataKey="missed" name="Missed" stackId="a" fill={PALETTE[5]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Talk time per day (minutes)</CardTitle>
                </CardHeader>
                <CardContent className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={d.daily}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.3} />
                      <XAxis
                        dataKey="date"
                        fontSize={11}
                        tickFormatter={(v: string) => v.slice(5)}
                      />
                      <YAxis fontSize={11} />
                      <Tooltip />
                      <Line
                        type="monotone"
                        dataKey="talkMinutes"
                        name="Minutes"
                        stroke={PALETTE[2]}
                        strokeWidth={2}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Languages className="h-4 w-4" />
                    Language pairs
                  </CardTitle>
                </CardHeader>
                <CardContent className="h-64">
                  {d.languagePairs.length === 0 ? (
                    <p className="pt-10 text-center text-sm text-muted-foreground">No data yet</p>
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={d.languagePairs}
                          dataKey="calls"
                          nameKey="pair"
                          outerRadius={85}
                          label={(e: { pair?: string }) => e.pair ?? ""}
                        >
                          {d.languagePairs.map((_, i) => (
                            <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                          ))}
                        </Pie>
                        <Tooltip />
                      </PieChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader className="flex-row items-center justify-between space-y-0">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Users className="h-4 w-4" />
                    Agent performance
                  </CardTitle>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => downloadCsv("calls-by-agent.csv", d.agents)}
                  >
                    <Download className="mr-1.5 h-3.5 w-3.5" />
                    CSV
                  </Button>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Agent</TableHead>
                        <TableHead className="text-right">Calls</TableHead>
                        <TableHead className="text-right">Talk time</TableHead>
                        <TableHead className="text-right">Avg</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.agents.length === 0 ? (
                        <TableRow>
                          <TableCell
                            colSpan={4}
                            className="text-center text-sm text-muted-foreground"
                          >
                            No agent data yet
                          </TableCell>
                        </TableRow>
                      ) : (
                        d.agents.map((a) => (
                          <TableRow key={a.userId}>
                            <TableCell className="font-medium">{a.name}</TableCell>
                            <TableCell className="text-right">{a.calls}</TableCell>
                            <TableCell className="text-right">{a.talkMinutes}m</TableCell>
                            <TableCell className="text-right">{fmtSec(a.avgDurationSec)}</TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex-row items-center justify-between space-y-0">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Video className="h-4 w-4" />
                    Most-called contacts
                  </CardTitle>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => downloadCsv("calls-by-contact.csv", d.contacts)}
                  >
                    <Download className="mr-1.5 h-3.5 w-3.5" />
                    CSV
                  </Button>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Contact</TableHead>
                        <TableHead className="text-right">Calls</TableHead>
                        <TableHead className="text-right">Talk time</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.contacts.map((c) => (
                        <TableRow key={c.name}>
                          <TableCell className="font-medium">{c.name}</TableCell>
                          <TableCell className="text-right">{c.calls}</TableCell>
                          <TableCell className="text-right">{c.talkMinutes}m</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
