import { useQuery } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { ApiRequestError, api } from "../../lib/api";
import type { Settings } from "../../lib/types";
import { AcquisitionForm } from "./AcquisitionForm";
import { FormulaForm } from "./FormulaForm";
import { IntegrationsForm } from "./IntegrationsForm";
import { OverridesForm } from "./OverridesForm";
import { PolicyForm } from "./PolicyForm";
import { SecurityForm } from "./SecurityForm";

export function SettingsPage() {
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<{ settings: Settings }>("/api/settings"),
  });

  if (settings.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading settings…</p>;
  }
  if (settings.error || !settings.data) {
    return (
      <p className="text-sm text-destructive">
        {settings.error instanceof ApiRequestError
          ? settings.error.message
          : "Failed to load settings"}
      </p>
    );
  }

  const s = settings.data.settings;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Settings</h1>
      <Tabs defaultValue="formula">
        <TabsList>
          <TabsTrigger value="formula">Formula</TabsTrigger>
          <TabsTrigger value="policy">Policy</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
          <TabsTrigger value="acquisition">Acquisition</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
          <TabsTrigger value="overrides">Overrides</TabsTrigger>
        </TabsList>
        <TabsContent value="formula">
          <FormulaForm settings={s} />
        </TabsContent>
        <TabsContent value="policy">
          <PolicyForm settings={s} />
        </TabsContent>
        <TabsContent value="integrations">
          <IntegrationsForm settings={s} />
        </TabsContent>
        <TabsContent value="acquisition">
          <AcquisitionForm settings={s} />
        </TabsContent>
        <TabsContent value="security">
          <SecurityForm settings={s} />
        </TabsContent>
        <TabsContent value="overrides">
          <OverridesForm settings={s} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
