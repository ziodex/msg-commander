export function legacyRegistrationWarning(kind: string): string | undefined {
	if (/^(Gcm|Fcm)(Template)?RegistrationDescription$/.test(kind))
		return 'GCM/FCM legacy is retired. Create a new FCM v1 registration with a current Firebase token; this definition remains available for inspection or export.'
	if (/^Mpns(Template)?RegistrationDescription$/.test(kind))
		return 'Microsoft no longer supports MPNS. Preserve or export the original XML for migration; a Windows WNS registration requires a new app/channel and cannot be converted by renaming this type.'
}
