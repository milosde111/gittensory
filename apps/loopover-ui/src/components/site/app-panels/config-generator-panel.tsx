import { useState } from "react";

import { AiProviderModeFieldGroup } from "@/components/site/app-panels/ai-provider-mode-field-group";
import { ConfigGeneratorYamlPreview } from "@/components/site/app-panels/config-generator-yaml-preview";
import { ReesAnalyzerFieldGroup } from "@/components/site/app-panels/rees-analyzer-field-group";
import type { GeneratorFormState } from "@/lib/config-generator-form-state";

const INITIAL_STATE: GeneratorFormState = {};

export function ConfigGeneratorPanel() {
  const [formState, setFormState] = useState<GeneratorFormState>(INITIAL_STATE);

  return (
    <div className="space-y-6">
      <AiProviderModeFieldGroup state={formState} onChange={setFormState} />
      <ReesAnalyzerFieldGroup state={formState} onChange={setFormState} />
      <ConfigGeneratorYamlPreview formState={formState} />
    </div>
  );
}
