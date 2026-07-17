export function resolveDemoCampaign(
  publicCampaign: string | undefined,
  serviceCampaign: string | undefined,
): string | null {
  return publicCampaign?.trim() || serviceCampaign?.trim() || null;
}
