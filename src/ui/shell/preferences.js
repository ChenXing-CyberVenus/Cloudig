// Preferences are small, explicit patches. Other Library actions can advance
// the revision without refreshing the page; never submit the page's old token.
export async function commitPreferencePatch(request, patch) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await request("library.preferences.query", {});
    try {
      return await request("library.preferences.commit", { ...patch, expected_revision: current.revision });
    } catch (error) {
      if (error?.code !== "CLOUDIG_LIBRARY_REVISION_CONFLICT" || attempt === 1) throw error;
    }
  }
}
