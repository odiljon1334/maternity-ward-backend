CREATE INDEX "AuditLog_createdAt_id_idx" ON "AuditLog"("createdAt", "id");
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");
CREATE INDEX "AuditLog_ip_createdAt_idx" ON "AuditLog"("ip", "createdAt");
