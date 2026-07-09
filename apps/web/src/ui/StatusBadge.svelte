<script lang="ts">
  // 状態表示のピルバッジ(盾/鈍化/加速/警告)。色分けのみを担う表示部品。
  interface Props {
    variant: 'shield' | 'slow' | 'haste' | 'warning';
    label: string;
    /** 未指定時は variant='warning' のみ role="alert"。接続状況バナー等、頻繁に
     * 更新される非緊急の通知は呼び出し側で role="status"(polite)を明示すること。 */
    role?: 'alert' | 'status';
  }

  const { variant, label, role }: Props = $props();
</script>

<span class="badge {variant}" role={role ?? (variant === 'warning' ? 'alert' : undefined)}
  >{label}</span
>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    font-family: var(--font-body);
    font-weight: 500;
    font-size: 20px;
    line-height: 1;
    padding: 7px 16px;
    border-radius: var(--radius-pill);
    border: 1px solid transparent;
    text-align: center;
  }

  .shield {
    color: var(--status-shield-text);
    background: var(--status-shield-bg);
    border-color: var(--status-shield-text);
  }

  .slow {
    color: var(--status-slow-text);
    background: var(--status-slow-bg);
    border-color: var(--status-slow-text);
  }

  .haste {
    color: var(--status-haste-text);
    background: var(--status-haste-bg);
    border-color: var(--status-haste-text);
  }

  .warning {
    color: var(--status-warning-text);
    background: var(--status-warning-bg);
    border-color: var(--status-warning-border);
  }
</style>
