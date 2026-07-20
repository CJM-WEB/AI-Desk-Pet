export const ipcChannels = {
  appGetStatus: 'app:get-status',
  appQuit: 'app:quit',
  settingsGet: 'settings:get',
  settingsSaveProvider: 'settings:save-provider',
  settingsTestProvider: 'settings:test-provider',
  settingsChooseRoot: 'settings:choose-root',
  settingsClearLocalData: 'settings:clear-local-data',
  chatSubmit: 'chat:submit',
  chatCancel: 'chat:cancel',
  actionConfirm: 'action:confirm',
  actionCancel: 'action:cancel',
  taskEvent: 'task:event',
  windowOpenChat: 'window:open-chat',
  windowOpenSettings: 'window:open-settings',
  windowHideChat: 'window:hide-chat'
} as const;
