/* mobile-fix.js - 手機濾鏡相容性修復
 * 
 * 使用方法：
 * 1. 將此檔案放到 public/ 目錄
 * 2. 在 broadcaster.html 的 <head> 中加入：
 *    <script src="mobile-fix.js"></script>
 * 3. 在建立 FilterManager 之前呼叫 getMobileOptimizedConfig()
 */

(function() {
  'use strict';

  // 偵測裝置類型
  function detectDevice() {
    const ua = navigator.userAgent;
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
    const isIOS = /iPhone|iPad|iPod/i.test(ua);
    const isAndroid = /Android/i.test(ua);
    const isTablet = /iPad|Android.*Tablet/i.test(ua);
    
    return {
      isMobile,
      isIOS,
      isAndroid,
      isTablet,
      isDesktop: !isMobile
    };
  }

  // 檢查瀏覽器功能支援
  function checkCapabilities() {
    return {
      wasm: !!window.WebAssembly,
      captureStream: !!HTMLCanvasElement.prototype.captureStream,
      getUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      offscreenCanvas: !!window.OffscreenCanvas,
      webgl: (function() {
        try {
          const canvas = document.createElement('canvas');
          return !!(canvas.getContext('webgl') || canvas.getContext('experimental-webgl'));
        } catch (e) {
          return false;
        }
      })()
    };
  }

  // 取得最佳化配置
  function getMobileOptimizedConfig() {
    const device = detectDevice();
    const caps = checkCapabilities();

    // 基礎配置（桌面全功能）
    let config = {
      width: 1280,
      height: 720,
      fps: 25,
      autoFace: true,
      device,
      capabilities: caps
    };

    // iOS 裝置優化
    if (device.isIOS) {
      config.width = 640;
      config.height = 480;
      config.fps = 15;
      config.autoFace = false; // iOS Safari 對 WASM 支援較差
      console.warn('[Mobile Fix] iOS 偵測：已降級至相容模式');
    }
    // Android 裝置優化
    else if (device.isAndroid) {
      config.width = 854;
      config.height = 480;
      config.fps = 20;
      // 只在支援 WASM 時啟用臉部偵測
      config.autoFace = caps.wasm;
      console.info('[Mobile Fix] Android 偵測：中階模式');
    }
    // 平板優化
    else if (device.isTablet) {
      config.width = 1024;
      config.height = 576;
      config.fps = 20;
      config.autoFace = caps.wasm;
    }

    // 功能降級檢查
    if (!caps.wasm) {
      config.autoFace = false;
      console.warn('[Mobile Fix] WebAssembly 不支援：臉部偵測已停用');
    }

    if (!caps.captureStream) {
      console.error('[Mobile Fix] 瀏覽器不支援 canvas.captureStream()，濾鏡功能可能無法運作');
      alert('您的瀏覽器版本過舊，請更新到最新版本以使用濾鏡功能');
    }

    // 記憶體限制偵測（簡易版）
    if (navigator.deviceMemory && navigator.deviceMemory < 4) {
      config.width = Math.min(config.width, 640);
      config.height = Math.min(config.height, 480);
      config.fps = Math.min(config.fps, 15);
      console.warn('[Mobile Fix] 低記憶體裝置偵測：進一步降級');
    }

    return config;
  }

  // 顯示相容性報告（開發用）
  function showCompatibilityReport() {
    const device = detectDevice();
    const caps = checkCapabilities();
    const config = getMobileOptimizedConfig();

    console.group('📱 Mobile Compatibility Report');
    console.log('Device:', device);
    console.log('Capabilities:', caps);
    console.log('Optimized Config:', config);
    console.groupEnd();

    return { device, caps, config };
  }

  // 監控效能並自動調整（可選）
  function createPerformanceMonitor(filterManager) {
    let frameCount = 0;
    let lastTime = performance.now();
    let lowFpsCount = 0;

    const monitor = setInterval(() => {
      const now = performance.now();
      const elapsed = (now - lastTime) / 1000;
      const actualFps = frameCount / elapsed;

      // 如果實際 FPS 持續低於目標的 70%，發出警告
      if (actualFps < filterManager.fps * 0.7) {
        lowFpsCount++;
        if (lowFpsCount >= 3) {
          console.warn(`[Performance] 實際 FPS (${actualFps.toFixed(1)}) 低於預期 (${filterManager.fps})，建議降低解析度或關閉臉部偵測`);
          lowFpsCount = 0;
        }
      } else {
        lowFpsCount = 0;
      }

      frameCount = 0;
      lastTime = now;
    }, 2000);

    // 計數器（需要在 FilterManager 的 draw loop 中呼叫）
    return {
      countFrame: () => frameCount++,
      stop: () => clearInterval(monitor)
    };
  }

  // 掛載到全域
  window.MobileFix = {
    detectDevice,
    checkCapabilities,
    getMobileOptimizedConfig,
    showCompatibilityReport,
    createPerformanceMonitor
  };

  // 自動顯示報告（開發模式）
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(showCompatibilityReport, 1000);
    });
  }

})();
