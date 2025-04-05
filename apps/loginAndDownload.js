const fs = require('fs');
const puppeteer = require('puppeteer');
const cliProgress = require('cli-progress');
const UserAgent1 = require('user-agents');  // 引入生成随机用户代理模块

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

// 从DOM中提取验证码数据
async function extractCaptchaDataFromDOM(page) {
  try {
    console.log('从DOM中提取验证码数据...');
    
    // 尝试多种可能的选择器
    const possibleTileSelectors = [
      '.index-module_tile__8pkQD',
      'div[class*="tile"]',
      'div[style*="width"][style*="height"][style*="top"][style*="left"]'
    ];
    
    // 查找滑块元素
    let tileElement = null;
    for (const selector of possibleTileSelectors) {
      console.log(`尝试选择器: ${selector}`);
      tileElement = await page.$(selector);
      if (tileElement) {
        console.log(`找到滑块元素: ${selector}`);
        break;
      }
    }
    
    if (!tileElement) {
      // 如果无法找到滑块元素，尝试从页面中提取所有可能的滑块元素
      console.log('无法找到滑块元素，尝试分析页面元素...');
      
      // 提取滑块位置信息
      const tileInfo = await page.evaluate(() => {
        // 查找所有可能的滑块元素
        const elements = Array.from(document.querySelectorAll('div[style*="width"][style*="height"][style*="top"][style*="left"]'));
        
        // 筛选可能的滑块元素
        for (const el of elements) {
          const style = window.getComputedStyle(el);
          const width = parseInt(style.width);
          const height = parseInt(style.height);
          
          // 滑块通常是一个小方块，宽高在50-100像素之间
          if (width >= 50 && width <= 100 && height >= 50 && height <= 100) {
            return {
              width: width,
              height: height,
              top: parseInt(style.top),
              left: parseInt(style.left)
            };
          }
        }
        
        return null;
      });
      
      if (!tileInfo) {
        throw new Error('无法找到滑块元素');
      }
      
      console.log('通过分析页面元素找到可能的滑块:', JSON.stringify(tileInfo));
      
      // 构造验证码数据对象
      const captchaData = {
        dots: {
          x: tileInfo.left + tileInfo.width / 2, // 滑块中心点的x坐标
          y: tileInfo.top + tileInfo.height / 2, // 滑块中心点的y坐标
          width: tileInfo.width,
          height: tileInfo.height
        }
      };
      
      return captchaData;
    }
    
    // 提取滑块位置信息
    const tileInfo = await page.evaluate(el => {
      const style = window.getComputedStyle(el);
      return {
        width: parseInt(style.width),
        height: parseInt(style.height),
        top: parseInt(style.top),
        left: parseInt(style.left)
      };
    }, tileElement);
    
    console.log('成功提取滑块位置信息:', JSON.stringify(tileInfo));
    
    // 构造验证码数据对象
    const captchaData = {
      dots: {
        x: tileInfo.left + tileInfo.width / 2, // 滑块中心点的x坐标
        y: tileInfo.top + tileInfo.height / 2, // 滑块中心点的y坐标
        width: tileInfo.width,
        height: tileInfo.height
      }
    };
    
    return captchaData;
  } catch (error) {
    console.log('提取验证码数据失败:', error.message);
    
    // 如果无法提取验证码数据，返回一个默认值
    console.log('使用默认滑块位置...');
    return {
      dots: {
        x: 150, // 默认滑动到中间位置
        y: 100,
        width: 60,
        height: 60
      }
    };
  }
}

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
      
      // 尝试使用不同的选择器提取验证码数据
      let captchaData;
      try {
        captchaData = await extractCaptchaDataFromDOM(page);
        console.log('成功提取验证码数据');
        console.log('获取到验证码数据:', JSON.stringify({
          x: captchaData.dots.x,
          y: captchaData.dots.y,
          width: captchaData.dots.width,
          height: captchaData.dots.height
        }));
      } catch (error) {
        console.log('提取验证码数据失败，使用默认值:', error.message);
        captchaData = {
          dots: {
            x: 150, // 默认滑动到中间位置
            y: 100,
            width: 60,
            height: 60
          }
        };
      }
      
      // 3. 尝试查找滑块元素
      let slider = null;
      const possibleSliderSelectors = [
        '.gocaptcha-module_dragBlock__bFlwx',
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
      
      if (!slider) {
        console.log('无法找到滑块元素，尝试查找任何可能的滑块');
        // 尝试查找任何可能的滑块元素
        slider = await page.$('div[style*="left: 0px"]');
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
      
      // 5. 计算目标位置和移动距离
      const targetX = captchaData.dots.x;
      // 滑块需要移动的距离 = 目标位置 - 滑块宽度/2（因为我们要让滑块中心对准目标位置）
      const moveDistance = targetX - sliderBox.width/2;
      console.log(`目标位置: x=${targetX}, 移动距离: ${moveDistance}px`);
      
      // 6. 模拟人类拖动行为
      await page.mouse.move(sliderBox.x + sliderBox.width/2, sliderBox.y + sliderBox.height/2);
      await page.mouse.down();
      await new Promise(resolve => setTimeout(resolve, getShortRandomDelay())); // 短暂停顿
      
      // 生成人类般的移动轨迹（从滑块当前位置移动到目标位置）
      const path = generateHumanLikePath(sliderBox.x + sliderBox.width/2, sliderBox.x + moveDistance, sliderBox.y + sliderBox.height/2);
      
      // 按照轨迹移动鼠标
      for (const point of path) {
        await page.mouse.move(point.x, point.y);
        await new Promise(r => setTimeout(r, point.delay));
      }
      
      // 释放鼠标
      await page.mouse.up();
      console.log('滑块拖动完成，等待验证结果...');
      
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

    // 换行
    console.log('\n');

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