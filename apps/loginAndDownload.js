const fs = require('fs');
const puppeteer = require('puppeteer');
const cliProgress = require('cli-progress');
const UserAgent1 = require('user-agents');  // 引入生成随机用户代理模块
// 注意：需要安装以下依赖
// npm install jimp pixelmatch
const Jimp = require('jimp');
const pixelmatch = require('pixelmatch');

const MAX_RETRIES = 2; // 最大重试次数
const MAX_CAPTCHA_RETRIES = 3; // 验证码最大重试次数

// 生成随机延迟（500 到 2000 毫秒之间）
function getRandomDelay() {
  return Math.floor(Math.random() * 1500) + 500;
}

// 生成更短的随机延迟（50 到 150 毫秒之间）
function getShortRandomDelay() {
  return Math.floor(Math.random() * 100) + 50;
}

// 生成随机视口大小
function getRandomViewport() {
  const width = Math.floor(Math.random() * (1920 - 1024)) + 1024;
  const height = Math.floor(Math.random() * (1080 - 768)) + 768;
  return { width, height };
}

// 生成类似人类的滑动轨迹
function generateHumanLikePath(startX, endX, y) {
  const distance = endX - startX;
  const steps = Math.floor(Math.random() * 20) + 30; // 30-50步
  const path = [];
  
  // 添加微小抖动和非线性速度
  for (let i = 0; i <= steps; i++) {
    const progress = i / steps;
    
    // 使用三次贝塞尔曲线模拟加速-减速模式
    let factor;
    if (progress < 0.2) {
      // 开始慢
      factor = 3 * Math.pow(progress, 2);
    } else if (progress > 0.8) {
      // 结束慢
      factor = 1 - Math.pow(1.5 * (1 - progress), 2);
    } else {
      // 中间快
      factor = 0.2 + (progress - 0.2) * 1.2;
    }
    
    // 添加随机抖动（垂直方向）
    const jitter = Math.random() * 3 - 1.5;
    
    // 添加随机抖动（水平方向，使移动不是完全线性的）
    const horizontalJitter = Math.random() * 2 - 1;
    
    path.push({
      x: startX + distance * factor + horizontalJitter,
      y: y + jitter,
      delay: Math.floor(Math.random() * 10) + 5 // 5-15ms的随机延迟
    });
  }
  
  return path;
}

// 截取验证码图片并保存
async function captureAndAnalyzeCaptcha(page) {
  try {
    console.log('截取验证码图片进行分析...');
    
    // 等待验证码图片加载
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // 查找验证码容器
    const captchaContainer = await page.$('.gocaptcha-module_wrapper__Kpdey, div[class*="captcha"], div[class*="gocaptcha"]');
    if (!captchaContainer) {
      console.log('未找到验证码容器');
      throw new Error('未找到验证码容器');
    }
    
    // 截取验证码图片
    const captchaDir = './captcha_images';
    if (!fs.existsSync(captchaDir)) {
      fs.mkdirSync(captchaDir);
    }
    
    // 截取验证码容器的图片
    const originalImagePath = `${captchaDir}/original_captcha.png`;
    await captchaContainer.screenshot({ path: originalImagePath });
    console.log(`已保存验证码原始图片: ${originalImagePath}`);
    
    // 等待一段时间，然后截取滑块移动后的图片
    await page.mouse.move(100, 100); // 移动鼠标到其他位置，确保滑块显示
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const sliderImagePath = `${captchaDir}/slider_captcha.png`;
    await captchaContainer.screenshot({ path: sliderImagePath });
    console.log(`已保存滑块图片: ${sliderImagePath}`);
    
    // 分析图片，找出滑块和目标位置
    const result = await analyzeSliderCaptcha(originalImagePath, sliderImagePath);
    return result;
  } catch (error) {
    console.log('截取验证码图片失败:', error.message);
    throw error;
  }
}

// 分析滑块验证码图片，找出滑块和目标位置
async function analyzeSliderCaptcha(originalImagePath, sliderImagePath) {
  try {
    console.log('分析滑块验证码图片...');
    
    // 读取图片
    const originalImage = await Jimp.read(originalImagePath);
    const sliderImage = await Jimp.read(sliderImagePath);
    
    // 获取图片尺寸
    const width = originalImage.getWidth();
    const height = originalImage.getHeight();
    
    // 创建差异图像
    const diffImage = new Jimp(width, height);
    
    // 使用pixelmatch比较两张图片的差异
    const diffPixels = pixelmatch(
      originalImage.bitmap.data,
      sliderImage.bitmap.data,
      diffImage.bitmap.data,
      width,
      height,
      { threshold: 0.1 } // 阈值，越小越敏感
    );
    
    // 保存差异图像用于调试
    await diffImage.writeAsync(`./captcha_images/diff_captcha.png`);
    console.log('已保存差异图片: ./captcha_images/diff_captcha.png');
    
    // 分析差异图像，找出滑块位置
    const sliderPosition = findSliderPosition(diffImage);
    console.log('滑块位置:', sliderPosition);
    
    // 分析原始图像，找出目标位置
    const targetPosition = findTargetPosition(originalImage, diffImage, sliderPosition);
    console.log('目标位置:', targetPosition);
    
    // 计算需要移动的距离
    const moveDistance = targetPosition.x - sliderPosition.x;
    console.log('需要移动的距离:', moveDistance);
    
    return {
      sliderPosition,
      targetPosition,
      moveDistance
    };
  } catch (error) {
    console.log('分析滑块验证码图片失败:', error.message);
    throw error;
  }
}

// 在差异图像中找出滑块位置
function findSliderPosition(diffImage) {
  const width = diffImage.getWidth();
  const height = diffImage.getHeight();
  
  // 查找差异最明显的区域作为滑块位置
  let maxDiffX = 0;
  let maxDiffY = 0;
  let maxDiffCount = 0;
  
  // 扫描图像，寻找差异点最集中的区域
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // 获取当前像素的RGBA值
      const rgba = Jimp.intToRGBA(diffImage.getPixelColor(x, y));
      
      // 如果像素有明显差异（非黑色）
      if (rgba.r > 30 || rgba.g > 30 || rgba.b > 30) {
        // 计算周围30x30区域内的差异点数量
        let diffCount = 0;
        for (let dy = -15; dy <= 15; dy++) {
          for (let dx = -15; dx <= 15; dx++) {
            if (y + dy >= 0 && y + dy < height && x + dx >= 0 && x + dx < width) {
              const pixelRgba = Jimp.intToRGBA(diffImage.getPixelColor(x + dx, y + dy));
              if (pixelRgba.r > 30 || pixelRgba.g > 30 || pixelRgba.b > 30) {
                diffCount++;
              }
            }
          }
        }
        
        // 更新最大差异区域
        if (diffCount > maxDiffCount) {
          maxDiffCount = diffCount;
          maxDiffX = x;
          maxDiffY = y;
        }
      }
    }
  }
  
  return { x: maxDiffX, y: maxDiffY };
}

// 在原始图像中找出目标位置
function findTargetPosition(originalImage, diffImage, sliderPosition) {
  const width = originalImage.getWidth();
  const height = originalImage.getHeight();
  
  // 从滑块位置向右扫描，寻找可能的目标位置
  // 目标位置通常是图像中的缺口或颜色差异明显的区域
  
  let targetX = sliderPosition.x + 50; // 默认至少向右移动50像素
  let targetY = sliderPosition.y;
  
  // 扫描图像右侧部分
  for (let x = sliderPosition.x + 20; x < width - 20; x++) {
    // 在滑块高度附近检查垂直线上的像素
    let edgeDetected = false;
    let edgeStrength = 0;
    
    for (let y = Math.max(0, sliderPosition.y - 15); y < Math.min(height, sliderPosition.y + 15); y++) {
      // 检查水平方向的颜色变化
      if (x + 1 < width) {
        const pixel1 = Jimp.intToRGBA(originalImage.getPixelColor(x, y));
        const pixel2 = Jimp.intToRGBA(originalImage.getPixelColor(x + 1, y));
        
        // 计算相邻像素的颜色差异
        const diff = Math.abs(pixel1.r - pixel2.r) + Math.abs(pixel1.g - pixel2.g) + Math.abs(pixel1.b - pixel2.b);
        
        if (diff > 30) { // 颜色变化明显
          edgeStrength += diff;
          edgeDetected = true;
        }
      }
    }
    
    // 如果检测到边缘，并且边缘强度足够大
    if (edgeDetected && edgeStrength > 300) {
      targetX = x;
      break;
    }
  }
  
  // 确保目标位置在合理范围内
  targetX = Math.min(width - 20, Math.max(sliderPosition.x + 20, targetX));
  
  return { x: targetX, y: targetY };
}

// DOM提取方法已删除，完全使用图像识别方法

// 处理滑块验证码
async function handleCaptcha(page) {
  console.log('检测到人机验证，开始处理...');
  
  let captchaSuccess = false;
  let retryCount = 0;
  
  while (!captchaSuccess && retryCount < MAX_CAPTCHA_RETRIES) {
    try {
      // 1. 点击验证按钮
      const verifyButton = await page.$('div[aria-describedby][data-popupid]');
      if (!verifyButton) {
        console.log('未找到验证按钮');
        return false;
      }
      
      // 检查验证按钮是否已经验证成功
      const buttonStyle = await page.evaluate(el => el.getAttribute('style'), verifyButton);
      if (buttonStyle.includes('background: var(--semi-color-success-light-default)')) {
        console.log('验证已成功，无需再次验证');
        return true;
      }
      
      // 找到验证按钮内部的小方框并点击它
      const captchaCheckbox = await page.$('div[aria-describedby][data-popupid] div[style*="width: 18px"][style*="height: 18px"][style*="border-radius: 3px"]');
      if (captchaCheckbox) {
        console.log('找到验证按钮内的小方框，准备点击...');
        await captchaCheckbox.click();
      } else {
        // 如果找不到小方框，退回到点击整个验证按钮
        console.log('未找到验证按钮内的小方框，点击整个验证按钮...');
        await verifyButton.click();
      }
      console.log('已点击验证按钮，等待验证码加载...');
      
      // 截取点击后的屏幕截图，用于调试
      await page.screenshot({ path: 'captcha_click.png' });
      console.log('已保存点击验证按钮后的截图: captcha_click.png');
      
      // 等待验证码加载
      await new Promise(resolve => setTimeout(resolve, 2000)); // 等待验证码完全加载
      
      // 检查验证码弹窗是否出现
      const captchaPopup = await page.$('.gocaptcha-module_wrapper__Kpdey');
      if (!captchaPopup) {
        console.log('验证码弹窗未出现，可能点击未生效');
        // 再次尝试点击
        await verifyButton.click();
        await new Promise(resolve => setTimeout(resolve, 2000));
        await page.screenshot({ path: 'captcha_click_retry.png' });
        console.log('已保存重试点击后的截图: captcha_click_retry.png');
      }
      
      // 打印页面上所有可能的验证码相关元素，帮助调试
      const captchaElements = await page.evaluate(() => {
        const elements = [];
        // 查找所有可能的验证码相关元素
        document.querySelectorAll('div[class*="captcha"], div[class*="gocaptcha"], img').forEach(el => {
          elements.push({
            tagName: el.tagName,
            className: el.className,
            id: el.id,
            style: el.getAttribute('style')
          });
        });
        return elements;
      });
      
      console.log('页面上的验证码相关元素:', JSON.stringify(captchaElements, null, 2));
      
      // 使用图像识别方法分析验证码
      let captchaAnalysisResult;
      try {
        console.log('使用图像识别方法分析验证码...');
        captchaAnalysisResult = await captureAndAnalyzeCaptcha(page);
        console.log('图像识别分析结果:', JSON.stringify(captchaAnalysisResult));
      } catch (error) {
        console.log('图像识别分析失败:', error.message);
        // 图像识别失败时直接报错
        throw new Error('验证码图像识别失败，无法确定滑块移动距离');
      }
      
      // 3. 根据HTML结构精确查找滑块元素
      console.log('根据HTML结构精确查找滑块元素...');
      let slider = await page.$('.gocaptcha-module_dragBlock__bFlwx');
      
      if (!slider) {
        console.log('未找到主要滑块元素，尝试备用选择器...');
        const possibleSliderSelectors = [
          'div[class*="dragBlock"]',
          'div[class*="slider"]',
          'div[style*="left: 0px"]'
        ];
        
        for (const selector of possibleSliderSelectors) {
          console.log(`尝试查找滑块元素: ${selector}`);
          slider = await page.$(selector);
          if (slider) {
            console.log(`找到滑块元素: ${selector}`);
            break;
          }
        }
      } else {
        console.log('成功找到滑块元素: .gocaptcha-module_dragBlock__bFlwx');
      }
      
      if (!slider) {
        console.log('无法找到滑块元素，验证失败');
        throw new Error('无法找到滑块元素');
      }
      
      // 4. 获取滑块元素位置
      const sliderBox = await slider.boundingBox();
      if (!sliderBox) {
        console.log('无法获取滑块元素位置，验证失败');
        throw new Error('无法获取滑块元素位置');
      }
      
      // 5. 使用图像识别分析结果计算移动距离
      // 如果有图像识别结果，使用它；否则使用滑块位置和宽度计算
      let moveDistance;
      if (captchaAnalysisResult && captchaAnalysisResult.moveDistance) {
        // 获取验证码容器的尺寸，用于计算比例因子
        const captchaContainer = await page.$('.gocaptcha-module_wrapper__Kpdey, div[class*="captcha"], div[class*="gocaptcha"]');
        let scaleFactor = 1.0; // 默认比例因子
        
        if (captchaContainer) {
          const containerBox = await captchaContainer.boundingBox();
          if (containerBox) {
            // 计算图像坐标系和页面坐标系之间的比例
            // 假设图像分析时使用的图片宽度是验证码容器的实际宽度
            const imageWidth = captchaAnalysisResult.targetPosition.x + captchaAnalysisResult.sliderPosition.x;
            if (imageWidth > 0) {
              scaleFactor = containerBox.width / imageWidth;
              console.log(`验证码容器宽度: ${containerBox.width}px, 图像宽度: ${imageWidth}px, 比例因子: ${scaleFactor}`);
            }
          }
        }
        
        // 应用比例因子调整移动距离
        moveDistance = captchaAnalysisResult.moveDistance * scaleFactor;
        console.log(`原始移动距离: ${captchaAnalysisResult.moveDistance}px, 调整后的移动距离: ${moveDistance}px`);
      }
      console.log(`滑块位置: x=${sliderBox.x}, y=${sliderBox.y}, 宽度: ${sliderBox.width}, 高度: ${sliderBox.height}`);
      
      // 6. 模拟人类拖动行为
      await page.mouse.move(sliderBox.x + sliderBox.width/2, sliderBox.y + sliderBox.height/2);
      await page.mouse.down();
      await new Promise(resolve => setTimeout(resolve, getShortRandomDelay())); // 短暂停顿
      
      // 获取滑块初始位置的left值
      const initialLeft = await page.evaluate(el => {
        return el.style.left;
      }, slider);
      console.log(`滑块初始位置: left=${initialLeft}`);
      
      // 生成人类般的移动轨迹（从滑块当前位置移动到目标位置）
      const startX = sliderBox.x + sliderBox.width/2;
      const endX = startX + moveDistance;
      console.log(`生成移动轨迹: 从 ${startX.toFixed(2)}px 到 ${endX.toFixed(2)}px，移动距离: ${moveDistance.toFixed(2)}px`);
      
      // 保存移动前的截图
      await page.screenshot({ path: 'before_move.png' });
      console.log('已保存移动前的截图: before_move.png');
      
      // 生成移动轨迹
      const path = generateHumanLikePath(startX, endX, sliderBox.y + sliderBox.height/2);
      console.log(`已生成${path.length}个移动点的轨迹`);
      
      // 按照轨迹移动鼠标
      for (let i = 0; i < path.length; i++) {
        const point = path[i];
        await page.mouse.move(point.x, point.y);
        await new Promise(r => setTimeout(r, point.delay));
        
        // 在移动过程中截取一张中间状态的截图
        if (i === Math.floor(path.length / 2)) {
          await page.screenshot({ path: 'moving_halfway.png' });
          
          // 获取移动过程中的滑块位置
          const midwayLeft = await page.evaluate(el => {
            return el.style.left;
          }, slider);
          console.log(`移动过程中的滑块位置: left=${midwayLeft}`);
        }
      }
      
      // 释放鼠标
      await page.mouse.up();
      console.log('鼠标已释放，滑块拖动完成');
      
      // 保存移动后的截图
      await page.screenshot({ path: 'after_move.png' });
      console.log('已保存移动后的截图: after_move.png');
      
      // 7. 等待验证结果
      console.log('等待验证结果...');
      
      // 等待一段时间，让验证结果有时间更新
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // 检查验证按钮样式是否变为成功状态
      const successButton = await page.$('div[style*="background: var(--semi-color-success-light-default)"]');
      if (successButton) {
        console.log('验证成功! 按钮样式已更新为成功状态');
        captchaSuccess = true;
        return true;
      }
      
      // 如果按钮样式未变化，再等待一段时间
      console.log('按钮样式未变化，继续等待...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // 再次检查验证按钮样式
      const successButtonRetry = await page.$('div[style*="background: var(--semi-color-success-light-default)"]');
      if (successButtonRetry) {
        console.log('验证成功! 按钮样式已更新为成功状态');
        captchaSuccess = true;
        return true;
      } else {
        console.log('验证失败，准备重试...');
        retryCount++;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) {
      console.log('验证码处理出错:', error.message);
      retryCount++;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  return captchaSuccess;
}

async function loginAndDownload(account) {
  const userAgent2 = new UserAgent1(); // 创建 UserAgent 实例
  const randomUserAgent = userAgent2.toString(); // 获取随机用户代理

  // 从环境变量读取 Chromium 或 Chrome 的可执行文件路径
  const executablePath = process.env.CHROME_PATH || null; // 如果没有设置环境变量，则为 null

  const browser = await puppeteer.launch({
    headless: 'new', // 使用新的无头模式
    executablePath, // 使用环境变量中的路径，如果没有设置则使用 Puppeteer 内置的 Chromium
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-zygote',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      // `--proxy-server=http://127.0.0.1:20171` // 注释掉代理地址
    ],
    defaultViewport: getRandomViewport(), // 使用随机视口大小
    ignoreHTTPSErrors: true, // 忽略HTTPS错误
    waitForInitialPage: true, // 等待初始页面加载
  });

  const page = await browser.newPage();
  await page.setUserAgent(randomUserAgent); // 设置随机的 User-Agent

  // 确保 progressBar 在整个函数范围内定义
  let progressBar;

  try {
    // 显示进度条
    progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    progressBar.start(100, 0); // 开始进度条

    let retryCount = 0;
    let loginSuccess = false;

    while (retryCount < MAX_RETRIES && !loginSuccess) {
      try {
        
        await page.setDefaultTimeout(30000); // 设置默认超时时间为30秒
        await page.setDefaultNavigationTimeout(30000); // 设置导航超时时间为30秒

        await page.goto('https://deno-arna-ephone-proxy.deno.dev/login', {
          waitUntil: 'networkidle0',
          timeout: 30000
        });
        progressBar.update(20);

        // 等待页面加载完成
        await new Promise(resolve => setTimeout(resolve, 3000));

        // 等待对话框按钮出现
        await page.waitForSelector('#dialog-0 > div > div.semi-modal-footer > button.semi-button.semi-button-primary > span', {
          timeout: 30000,
          visible: true
        });
        const buttons1 = await page.$$('#dialog-0 > div > div.semi-modal-footer > button.semi-button.semi-button-primary > span');
        for (let button of buttons1) {
          const text = await page.evaluate(el => el.innerText, button);
          if (text === '确定') {
            const buttonBox = await button.boundingBox(); // 获取按钮的位置
            if (buttonBox) {
              await page.mouse.move(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2); // 模拟鼠标移动到按钮上
              await new Promise(resolve => setTimeout(resolve, getRandomDelay())); // 模拟点击停顿
              await page.mouse.click(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2); // 点击按钮
            }
          }
        }
        await new Promise(resolve => setTimeout(resolve, getRandomDelay()));
        
        // 输入用户名和密码，并添加随机延迟
        await page.waitForSelector('#username');
        await page.type('#username', account.username);
        await new Promise(resolve => setTimeout(resolve, getRandomDelay()));

        await page.waitForSelector('#password');
        await page.type('#password', account.password);
        await new Promise(resolve => setTimeout(resolve, getRandomDelay()));
        progressBar.update(50);

        // 检查是否存在人机验证按钮
        const verifyButton = await page.$('div[aria-describedby][data-popupid]');
        if (verifyButton) {
          console.log(`账户 ${account.username} 需要完成人机验证`);
          
          // 检查验证按钮是否已经验证成功
          const buttonStyle = await page.evaluate(el => el.getAttribute('style'), verifyButton);
          if (buttonStyle && buttonStyle.includes('background: var(--semi-color-success-light-default)')) {
            console.log(`账户 ${account.username} 已通过人机验证，无需再次验证`);
          } else {
            // 需要进行验证
            const captchaSuccess = await handleCaptcha(page);
            if (!captchaSuccess) {
              console.log(`账户 ${account.username} 人机验证失败`);
              throw new Error('人机验证失败');
            }
            
            // 验证成功后，再次检查验证按钮状态
            await new Promise(resolve => setTimeout(resolve, 1000)); // 等待状态更新
            const verifyButtonAfter = await page.$('div[aria-describedby][data-popupid]');
            if (verifyButtonAfter) {
              const buttonStyleAfter = await page.evaluate(el => el.getAttribute('style'), verifyButtonAfter);
              if (buttonStyleAfter && buttonStyleAfter.includes('background: var(--semi-color-success-light-default)')) {
                console.log(`账户 ${account.username} 验证状态已更新为成功`);
              } else {
                console.log(`警告: 账户 ${account.username} 验证可能成功但按钮状态未更新`);
              }
            }
            
            console.log(`账户 ${account.username} 人机验证成功，继续登录流程`);
          }
          
          progressBar.update(60);
        } else {
          console.log(`账户 ${account.username} 无需人机验证`);
        }
        
        // 短暂等待，确保验证状态已完全更新
        await new Promise(resolve => setTimeout(resolve, 1000));

        // 查找并点击登录按钮，模拟鼠标移动和点击
        await page.waitForSelector('button > span');
        const buttons = await page.$$('button > span');
        for (let button of buttons) {
          const text = await page.evaluate(el => el.innerText, button);
          if (text === '登录') {
            const buttonBox = await button.boundingBox(); // 获取按钮的位置
            if (buttonBox) {
              await page.mouse.move(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2); // 模拟鼠标移动到按钮上
              await new Promise(resolve => setTimeout(resolve, getRandomDelay())); // 模拟点击停顿
              await page.mouse.click(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2); // 点击按钮
            }
            break;
          }
        }

        // 等待 8 秒来检测是否跳转到目标页面
        await new Promise(resolve => setTimeout(resolve, 8000));

        // 检查是否跳转到 "/panel" 页面
        const currentUrl = page.url();
        if (currentUrl.includes('/panel')) {
          console.log(`账户 ${account.username} 登录成功！`);
          progressBar.update(70);
          loginSuccess = true;

          // 添加签到功能逻辑，等待签到页面加载
          await page.waitForSelector('#semiTabcheckin > span');
          await page.click('#semiTabcheckin > span');
          progressBar.update(80);

          // 查找签到按钮，判断是否存在 "去签到" 按钮
          const signInButton = await page.$('#semiTabPanelcheckin > div > div > div.semi-calendar-month-grid-wrapper > div > ul div[role="button"]');

          if (!signInButton) {
            // 没有找到签到按钮
            console.log(`账户 ${account.username} 已经签到，跳过签到流程`);
          } else {
            // 找到“去签到”按钮
            console.log(`账户 ${account.username} 尚未签到，准备进行签到...`);

            let signInSuccess = false;
            const spanText = await page.evaluate(el => el.innerText, signInButton);
            if (spanText.includes('去签到')) {  // 找到“去签到”按钮
              await signInButton.click();  // 点击“去签到”按钮
              console.log(`账户 ${account.username} 正在签到...`);

              // 等待元素的 class 和文本内容从 "去签到" 更新为 "已签到"
              await page.waitForFunction(
                el => el.innerText.includes('已签到') && el.classList.contains('semi-tag-green-light'),
                { timeout: 10000 }, 
                signInButton
              );

              console.log(`账户 ${account.username} 签到成功！`);
              signInSuccess = true;
            }

            if (!signInSuccess) {
              console.log(`账户 ${account.username} 签到失败，未找到“去签到”按钮`);
            }
          }

        } else {
          console.log(`账户 ${account.username} 登录失败，未跳转到预期页面`);
        }

      } catch (error) {
        console.log(`账户 ${account.username} 登录错误: ${error.message}`);
        retryCount++;
        if (retryCount < MAX_RETRIES) {
          // 等待 60 秒再重新尝试登录
          await new Promise(resolve => setTimeout(resolve, 60000));
          console.log(`重试登录（${retryCount}/${MAX_RETRIES}）...`);
        }
      }
    }

    if (!loginSuccess) {
      console.log(`账户 ${account.username} 登录失败，已达到最大重试次数`);
      return false;
    }
  } catch (error) {
    console.log(`账户 ${account.username} 登录错误: ${error.message}`);
    return false;
  } finally {
    if (progressBar) {  // 确保进度条存在再调用 stop()
      progressBar.stop();
    }
    await browser.close();
  }
}

// 调用此函数以对多个帐号进行签到
async function signInMultipleAccounts(accounts) {
  for (let account of accounts) {
    console.log(`正在处理账户 ${account.username}`);
    const result = await loginAndDownload(account);
    if (!result) {
      console.log(`账户 ${account.username} 登录失败，跳过该账户`);
    }
  }
}

module.exports = { loginAndDownload, signInMultipleAccounts };