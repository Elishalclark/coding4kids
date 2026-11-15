import UIKit
import Capacitor

class MainViewController: CAPBridgeViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        guard let scrollView = webView?.scrollView else { return }
        scrollView.alwaysBounceHorizontal = false
        scrollView.showsHorizontalScrollIndicator = false
    }
}
