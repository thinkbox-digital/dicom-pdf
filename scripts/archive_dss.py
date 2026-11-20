"""Independent bounded PDF DSS parsing. Embedded certificates never become roots."""
from asn1crypto import x509, crl, ocsp
from pypdf.generic import ArrayObject, DictionaryObject, StreamObject

MAX_ITEM = 16*1024**2
MAX_TOTAL = 32*1024**2
MAX_COUNT = 256


def read_dss(reader):
    catalog = reader.trailer['/Root'].get_object()
    value = catalog.get('/DSS')
    if value is None:
        return None
    value = value.get_object()
    if not isinstance(value, DictionaryObject) or isinstance(value, StreamObject):
        raise ValueError('Invalid DSS dictionary')
    if set(value) - {'/Type', '/Certs', '/CRLs', '/OCSPs'} or value.get('/Type', '/DSS') != '/DSS':
        raise ValueError('Unsupported DSS structure')
    total, result = 0, {}
    for key, schema in [('/Certs', x509.Certificate), ('/CRLs', crl.CertificateList), ('/OCSPs', ocsp.OCSPResponse)]:
        items = value.get(key)
        result[key] = []
        if items is None:
            continue
        items = items.get_object()
        if not isinstance(items, ArrayObject) or not 1 <= len(items) <= MAX_COUNT:
            raise ValueError('DSS array limit or type')
        for item in items:
            stream = item.get_object()
            if not isinstance(stream, StreamObject):
                raise ValueError('DSS stream required')
            # The host verifier sets pypdf's global decompression limit as well.
            data = stream.get_data()
            total += len(data)
            if not 1 <= len(data) <= MAX_ITEM or total > MAX_TOTAL:
                raise ValueError('DSS expanded evidence limit')
            parsed = schema.load(data, strict=True)
            if parsed.dump(force=True) != data:
                raise ValueError('DSS evidence must be exact DER')
            if key == '/OCSPs' and (parsed['response_status'].native != 'successful' or parsed['response_bytes']['response_type'].native != 'basic_ocsp_response'):
                raise ValueError('Successful basic OCSP response required')
            result[key].append(data)
    if not result['/Certs']:
        raise ValueError('DSS certificates missing')
    return result
