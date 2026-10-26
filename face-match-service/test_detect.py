"""Contract tests; actual model detection is checked separately against local samples."""
import base64
import io
import unittest
from unittest.mock import Mock, patch
from PIL import Image
from fastapi import HTTPException
import app

class DetectTests(unittest.TestCase):
    def image(self):
        buf=io.BytesIO()
        Image.new('RGB',(32,32),'green').save(buf,format='PNG')
        return base64.b64encode(buf.getvalue()).decode()

    def test_counts_zero_one_multiple_without_embeddings(self):
        for count in (0,1,2):
            analyzer=Mock()
            analyzer.det_model.detect.return_value=([object() for _ in range(count)],None)
            with patch.object(app,'get_analyzer',return_value=analyzer):
                result=app.detect(app.DetectRequest(image=self.image()))
            self.assertEqual(result.model_dump(),{'faceCount':count})
            analyzer.det_model.detect.assert_called_once()
            analyzer.get.assert_not_called()

    def test_invalid_image_is_bad_request_without_running_model(self):
        with patch.object(app,'get_analyzer') as analyzer:
            with self.assertRaises(HTTPException) as error:
                app.detect(app.DetectRequest(image='not an image'))
            self.assertEqual(error.exception.status_code,400)
            analyzer.assert_not_called()

if __name__=='__main__': unittest.main()
