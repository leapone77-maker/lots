Component({
  properties: {
    visible: { type: Boolean, value: false }
  },
  data: {
    phone: '',
    password: '',
    err: '',
    loading: false
  },
  observers: {
    'visible': function(val) {
      if (!val) {
        // 关闭时清空表单
        this.setData({ phone: '', password: '', err: '' });
      }
    }
  },
  methods: {
    noop: function() {},
    close: function() {
      this.triggerEvent('close');
    },
    onPhone: function(e) {
      this.setData({ phone: e.detail.value });
    },
    onPwd: function(e) {
      this.setData({ password: e.detail.value });
    },
    submit: function() {
      var self = this;
      this.setData({ err: '', loading: true });

      if (!/^1\d{10}$/.test(this.data.phone)) {
        this.setData({ err: '手机号格式不正确', loading: false });
        return;
      }
      if (this.data.password.length < 6) {
        this.setData({ err: '密码至少 6 位', loading: false });
        return;
      }

      // 调用云函数 register/login（一次调用，结果直接传给页面）
      wx.cloud.callFunction({
        name: 'jieqian',
        data: {
          action: 'register',
          phone: self.data.phone,
          password: self.data.password
        }
      }).then(function(res) {
        console.log('[login] 云函数返回:', JSON.stringify(res));
        self.setData({ loading: false });

        var result = res.result;
        if (!result) {
          self.setData({ err: '云函数未响应，请确认已部署' });
          return;
        }

        if (result.code === 0) {
          var tk = result.token || '';
          console.log('[login] token:', tk ? '有' : '无', ', 完整返回:', JSON.stringify(result));
          self.triggerEvent('login', {
            phone: self.data.phone,
            token: tk
          });
          self.close();
        } else {
          self.setData({
            err: result.msg || result.message || ('错误码:' + result.code)
          });
        }
      }).catch(function(e) {
        console.error('[login] 网络异常:', e);
        self.setData({ err: '网络连接失败：' + (e.errMsg || e.message || '未知'), loading: false });
      });
    }
  }
});
