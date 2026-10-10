import {
  BrainCircuit, Code2, Cpu, GraduationCap, House, Layers, Leaf,
  MapPin, Megaphone, ShieldCheck, ShoppingBag, Stethoscope,
  Truck, Users, Volleyball, Wallet, type LucideIcon,
} from "lucide-react";

const SHORT_LABELS: Record<string, string> = {
  "Health & Life Sciences": "Health & science",
  "Sports, Media & Entertainment": "Sports & media",
  "Defense & Government": "Defense & government",
  "Dual-Use & Defense Tech": "Defense tech",
  "Real Estate, Construction & Home": "Property & construction",
  "Enterprise & Developer Software": "Software",
  "Mobility, Logistics & Supply Chain": "Mobility & logistics",
  "Marketing, Sales & Customer Experience": "Marketing & sales",
  "Consumer, Commerce & Marketplaces": "Consumer & commerce",
  "Energy, Climate & Agriculture": "Climate & agriculture",
  "Work, Talent & Learning": "Work & learning",
  "Fintech & Financial Services": "Financial services",
  "Hardware & Deep Tech": "Hardware & deep tech",
  "Community Partners": "Community",
};

const ICONS: readonly { match: RegExp; icon: LucideIcon }[] = [
  { match: /health|life science|medical/i, icon: Stethoscope },
  { match: /\bai\b|artificial intelligence|data/i, icon: BrainCircuit },
  { match: /cybersecurity|defense|government|security/i, icon: ShieldCheck },
  { match: /real estate|construction|property|\bhome\b/i, icon: House },
  { match: /software|developer|enterprise/i, icon: Code2 },
  { match: /mobility|logistics|supply chain|transport/i, icon: Truck },
  { match: /marketing|sales|customer experience/i, icon: Megaphone },
  { match: /consumer|commerce|marketplace|retail/i, icon: ShoppingBag },
  { match: /energy|climate|agriculture|resilience/i, icon: Leaf },
  { match: /work|talent|learning|education/i, icon: GraduationCap },
  { match: /fintech|financial|finance/i, icon: Wallet },
  { match: /hardware|deep tech|robot/i, icon: Cpu },
  { match: /sports|media|entertainment/i, icon: Volleyball },
  { match: /community|partner/i, icon: Users },
  { match: /county|florida|miami|tampa|orlando|broward|palm beach|region/i, icon: MapPin },
];

/** Short labels are presentation only. Search and accessible names use the map's label. */
export function districtLabel(label: string): string {
  return SHORT_LABELS[label] ?? label;
}

export function DistrictIcon({ label, size = 18, className }: { label: string; size?: number; className?: string }) {
  const Icon = ICONS.find(({ match }) => match.test(label))?.icon ?? Layers;
  return <Icon size={size} className={className} aria-hidden="true" />;
}
