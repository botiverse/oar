/** Native 2.178.1 ExtensionMethod and extNotification call sites.
 * question and delegateTool are requests, not notifications. Preserve
 * received notifications without inventing typed UI, task or child semantics. */
export const codebuddyNotifications: readonly string[] = [
  "_codebuddy.ai/artifact",
  "_codebuddy.ai/artifactBatch",
  "_codebuddy.ai/checkpoint",
  "_codebuddy.ai/command",
  "_codebuddy.ai/authUrl",
  "_codebuddy.ai/liteModelReset",
  "_codebuddy.ai/file_history_snapshot",
  "_codebuddy.ai/delegateToolsChanged",
  "_codebuddy.ai/uiControl",
  "_codebuddy.ai/modRender",
  "_codebuddy.ai/modPress",
  "_codebuddy.ai/fileDirectoryApproval/committed",
  "_codebuddy.ai/modAuthoringChanged",
  "_codebuddy.ai/modClientQuery",
  "_codebuddy.ai/modClientQueryCancel",
  "_codebuddy.ai/modViewEvent",
  "_codebuddy.ai/modSlots",
  "_codebuddy.ai/modRenderFold",
  "_codebuddy.ai/modResidentInvalidate",
  "_codebuddy.ai/modComponentsChanged",
  "_codebuddy.ai/modClientReadyRequired",
  "_codebuddy.ai/modCustomizationChanged",
];
