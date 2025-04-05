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

// 等待验证码响应并提取信息
async function waitForCaptchaResponse(page) {
  return new Promise((resolve, reject) => {
    let captchaData = null;
    let responseTimeout = null;
    
    // 设置超时
    responseTimeout = setTimeout(() => {
      page.removeAllListeners('response');
      reject(new Error('等待验证码响应超时'));
    }, 10000);
    
    // 监听响应
    page.on('response', async (response) => {
      const url = response.url();
      
      // 检查是否是验证码响应
      if (url.includes('/captcha/get')) {
        try {
          const responseData = await response.json();
          if (responseData && responseData.data && responseData.data.dots) {
            captchaData = responseData.data;
            clearTimeout(responseTimeout);
            page.removeAllListeners('response');
            resolve(captchaData);
          }
        } catch (error) {
          console.log('解析验证码响应失败:', error.message);
        }
      }
    });
  });
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
      
      // 点击验证按钮
      await verifyButton.click();
      console.log('已点击验证按钮，等待验证码加载...');
      
      // 2. 等待验证码响应，获取dots信息
      const captchaData = await waitForCaptchaResponse(page);
      console.log('获取到验证码数据:', JSON.stringify({
        x: captchaData.dots.x,
        y: captchaData.dots.y,
        width: captchaData.dots.width,
        height: captchaData.dots.height
      }));
      
      // 3. 等待滑块元素加载
      await page.waitForSelector('.gocaptcha-module_dragBlock__bFlwx', { visible: true, timeout: 5000 });
      
      // 4. 获取滑块元素位置
      const slider = await page.$('.gocaptcha-module_dragBlock__bFlwx');
      const sliderBox = await slider.boundingBox();
      
      // 5. 计算目标位置（dots.x是目标位置）
      const targetX = captchaData.dots.x;
      
      // 6. 模拟人类拖动行为
      await page.mouse.move(sliderBox.x + sliderBox.width/2, sliderBox.y + sliderBox.height/2);
      await page.mouse.down();
      
      // 生成人类般的移动轨迹
      const path = generateHumanLikePath(sliderBox.x, sliderBox.x + targetX, sliderBox.y + sliderBox.height/2);
      
      // 按照轨迹移动鼠标
      for (const point of path) {
        await page.mouse.move(point.x, point.y);
        await new Promise(r => setTimeout(r, point.delay));
      }
      
      // 释放鼠标
      await page.mouse.up();
      console.log('滑块拖动完成，等待验证结果...');
      
      // 7. 等待验证结果
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // 8. 检查验证是否成功
      const successButton = await page.$('div[style*="background: var(--semi-color-success-light-default)"]');
      if (successButton) {
        console.log('验证成功!');
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
          const captchaSuccess = await handleCaptcha(page);
          if (!captchaSuccess) {
            console.log(`账户 ${account.username} 人机验证失败`);
            throw new Error('人机验证失败');
          }
          console.log(`账户 ${account.username} 人机验证成功，继续登录流程`);
          progressBar.update(60);
        } else {
          console.log(`账户 ${account.username} 无需人机验证`);
        }

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