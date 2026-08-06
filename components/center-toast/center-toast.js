Component({
  properties: {
    visible: { type: Boolean, value: false },
    message: { type: String, value: '' }
  },
  data: {
    rendered: false,
    boxStyle: 'opacity:1;'
  },
  lifetimes: {
    detached() {
      if (this._timer) clearInterval(this._timer)
    }
  },
  observers: {
    visible(v) {
      if (v) {
        if (this._timer) clearInterval(this._timer)
        this.setData({ rendered: true, boxStyle: 'opacity:0;' })
        // 淡入：opacity 0→1，持续 300ms
        this._tween(0, 1, 300, val => {
          this.setData({ boxStyle: `opacity:${val};` })
        }, () => {
          this.setData({ boxStyle: 'opacity:1;' })
        })
      } else if (this.data.rendered) {
        if (this._timer) clearInterval(this._timer)
        // 上滑：translateY 0→-2000rpx，opacity 全程保持 1，持续 400ms
        this._tween(0, -2000, 400, val => {
          this.setData({ boxStyle: `opacity:1;transform:translateY(${val}rpx);` })
        }, () => {
          this.setData({ rendered: false, boxStyle: 'opacity:1;' })
        })
      }
    }
  },
  methods: {
    _tween(from, to, duration, onUpdate, onDone) {
      const start = Date.now()
      this._timer = setInterval(() => {
        const elapsed = Date.now() - start
        let t = elapsed / duration
        if (t >= 1) {
          clearInterval(this._timer)
          this._timer = null
          onUpdate(to)
          onDone()
        } else {
          // ease-out
          const eased = 1 - Math.pow(1 - t, 3)
          onUpdate(from + (to - from) * eased)
        }
      }, 16)
    }
  }
})
