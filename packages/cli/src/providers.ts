import { createGateway, type GatewayConfig } from "@drost/core";

function usage(): void {
  process.stdout.write(
    [
      "Usage:",
      "  drost providers list",
      "  drost providers probe [timeoutMs]"
    ].join("\n") + "\n"
  );
}

export async function runProvidersCommand(args: string[], config: GatewayConfig): Promise<number> {
  const command = args[0] ?? "list";
  const gateway = createGateway(config);

  if (command === "list") {
    const profiles = gateway.listProviderProfiles();
    if (profiles.length === 0) {
      process.stdout.write("No provider profiles configured.\n");
      return 0;
    }
    process.stdout.write("Configured provider profiles:\n");
    for (const profile of profiles) {
      process.stdout.write(
        [
          `- ${profile.id}`,
          `kind=${profile.kind}`,
          `adapter=${profile.adapterId}`,
          `model=${profile.model}`,
          `auth=${profile.authProfileId}`,
          `baseUrl=${profile.baseUrl ?? "(default)"}`
        ].join("  ") + "\n"
      );
    }
    return 0;
  }

  if (command === "probe") {
    const timeoutRaw = args[1];
    const timeoutMs = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : 10_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      process.stderr.write(`Invalid timeout: ${timeoutRaw}\n`);
      return 1;
    }

    const diagnostics = await gateway.probeProviders(timeoutMs);
    if (diagnostics.length === 0) {
      process.stdout.write("No provider profiles configured.\n");
      return 0;
    }

    const failed = diagnostics.filter((entry) => !entry.ok).length;
    for (const result of diagnostics) {
      process.stdout.write(
        `- ${result.providerId}  ok=${result.ok}  code=${result.code}  message=${result.message}\n`
      );
    }

    return failed > 0 ? 2 : 0;
  }

  usage();
  return 1;
}
