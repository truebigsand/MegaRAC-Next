<script setup lang="ts">
import { NCard, NAlert, NButton, NSpace, NList, NListItem, NTimeline, NTimelineItem } from 'naive-ui';

function openOriginalKvm() {
  // 兜底方案：新开原版 UI 的远程控制页（需在原版界面单独登录一次）
  window.open('https://192.168.0.200/#remote_control', '_blank', 'noopener');
}
</script>

<template>
  <n-space vertical size="large">
    <n-card title="KVM 远程控制台">
      <n-alert type="warning" :bordered="false">
        SP-X 的 KVM 走 AMI 私有二进制协议（非标准 VNC），完整自研逆向工作量较大且当前主机处于 POST 循环、画面可测性差。
        按设计共识，v1 提供<b>跳转原版 KVM 兜底</b>，协议自研放后续版本。
      </n-alert>
      <n-space style="margin-top: 16px">
        <n-button type="primary" @click="openOriginalKvm">打开原版 KVM 页面（新窗口）</n-button>
      </n-space>
    </n-card>

    <n-card title="协议调研结论（阶段⑦）">
      <n-timeline>
        <n-timeline-item type="info" title="传输层已探明">
          视频/键鼠：wss://&lt;bmc&gt;/kvm（443 同端口，lighttpd 反代），子协议 binary/base64；
          SOL：wss://&lt;bmc&gt;/sol?CSRFTOKEN=；虚拟媒体 iusb：独立端口 9667。
        </n-timeline-item>
        <n-timeline-item type="info" title="协议常量已定位">
          全部 CMD_*（KEEP_ALIVE、IPMI_REQ_COMMAND、POWER_CTRL_REQUEST、KVM_SHARING、PAUSE_REDIRECTION、
          STOP_SESSION_IMMEDIATE 等）与 STATUS_KVM_PRIV_* 状态机都在原版 viewer.min.js（1.6MB）内，
          帧格式 createHeader(cmd,len,status,payload) —— 自研所需信息基本齐备。
        </n-timeline-item>
        <n-timeline-item type="warning" title="现成库调研">
          未找到可直接复用的开源 SP-X KVM 实现；最接近的参考是
          MagnaCapax/mcxBMCView（AMI MegaRAC HTML5 KVM 截屏逆向实践）。
          SP-X 官方 Developer Guide 仅在 AMI 支持体系内提供。
        </n-timeline-item>
        <n-timeline-item type="default" title="后续路线">
          v2 自研建议：Node 侧 ws 客户端连 wss/kvm，按 createHeader 复刻帧协议，Canvas 渲染视频流 + 键鼠事件回传；
          先只读观景（视频+键鼠），虚拟介质（9667 端口独立协议）再后。
        </n-timeline-item>
      </n-timeline>
    </n-card>

    <n-card title="参考链接">
      <n-list>
        <n-list-item>
          <a href="https://github.com/MagnaCapax/mcxBMCView" target="_blank" rel="noopener">MagnaCapax/mcxBMCView — AMI MegaRAC KVM 逆向参考</a>
        </n-list-item>
        <n-list-item>
          <a href="https://www.nozominetworks.com/blog/vulnerabilities-in-bmc-firmware-affect-ot-iot-device-security-part-2" target="_blank" rel="noopener">Nozomi Networks — MegaRAC SP-X 协议研究</a>
        </n-list-item>
      </n-list>
    </n-card>
  </n-space>
</template>
